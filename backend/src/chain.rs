use alloy::{
    network::EthereumWallet,
    primitives::{Address, Bytes, FixedBytes, U256, keccak256},
    providers::ProviderBuilder,
    signers::{Signer, local::PrivateKeySigner},
    sol,
    sol_types::SolValue,
};
use serde::Serialize;
use std::fmt;

#[derive(Clone, Serialize, utoipa::ToSchema)]
pub struct ContractConfig {
    pub resolver: String,
    #[serde(rename = "commitmentAddress")]
    pub commitment_address: String,
    #[serde(rename = "statsAddress", skip_serializing_if = "Option::is_none")]
    pub stats_address: Option<String>,
    #[serde(rename = "pvpEnabled")]
    pub pvp_enabled: bool,
}

sol! {
    #[sol(rpc)]
    interface IWordCommitment {
        function commit(bytes32 gameId, bytes32 commitmentHash) external;
        function reveal(bytes32 gameId, uint256 wordIndex, bytes32 salt) external;
    }

    #[sol(rpc)]
    interface IWordCircleStats {
        function recordPvpResult(
            bytes32 gameId,
            address player,
            bool won,
            uint256 amountWagered,
            uint256 amountEarned
        ) external;
    }

    #[sol(rpc)]
    interface IWordCirclesEscrow {
        function resolve(
            bytes32 gameId,
            address[] calldata winners,
            uint256[] calldata amounts,
            bytes calldata signature
        ) external;
    }
}

#[derive(Debug)]
pub enum ChainError {
    Config(String),
    Signing(String),
    Transport(String),
}

impl fmt::Display for ChainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Config(msg) => write!(f, "config: {msg}"),
            Self::Signing(msg) => write!(f, "signing: {msg}"),
            Self::Transport(msg) => write!(f, "transport: {msg}"),
        }
    }
}

impl std::error::Error for ChainError {}

pub struct ResolverClient {
    signer: PrivateKeySigner,
    rpc_url: String,
    pub commitment_address: Address,
    pub escrow_address: Option<Address>,
    pub stats_address: Option<Address>,
}

impl ResolverClient {
    pub fn from_env() -> Result<Self, ChainError> {
        let key_hex = std::env::var("RESOLVER_PRIVATE_KEY")
            .map_err(|_| ChainError::Config("RESOLVER_PRIVATE_KEY not set".into()))?;
        let rpc_url =
            std::env::var("RPC_URL").map_err(|_| ChainError::Config("RPC_URL not set".into()))?;
        let commitment_hex = std::env::var("COMMITMENT_ADDRESS")
            .map_err(|_| ChainError::Config("COMMITMENT_ADDRESS not set".into()))?;
        let escrow_address = std::env::var("ESCROW_ADDRESS")
            .ok()
            .and_then(|s| s.parse().ok());
        let stats_address = std::env::var("STATS_ADDRESS")
            .ok()
            .and_then(|s| s.parse().ok());

        let signer: PrivateKeySigner = key_hex
            .parse()
            .map_err(|e| ChainError::Config(format!("invalid private key: {e}")))?;
        let commitment_address: Address = commitment_hex
            .parse()
            .map_err(|e| ChainError::Config(format!("invalid commitment address: {e}")))?;

        Ok(Self {
            signer,
            rpc_url,
            commitment_address,
            escrow_address,
            stats_address,
        })
    }

    pub fn address(&self) -> Address {
        self.signer.address()
    }

    pub fn config(&self, pvp_enabled: bool) -> ContractConfig {
        ContractConfig {
            resolver: self.signer.address().to_string(),
            commitment_address: self.commitment_address.to_string(),
            stats_address: self.stats_address.map(|a| a.to_string()),
            pvp_enabled,
        }
    }

    pub async fn commit(
        &self,
        game_id: [u8; 32],
        commitment_hash: [u8; 32],
    ) -> Result<FixedBytes<32>, ChainError> {
        let provider = self.build_provider()?;
        let contract = IWordCommitment::new(self.commitment_address, &provider);

        let receipt = contract
            .commit(game_id.into(), commitment_hash.into())
            .send()
            .await
            .map_err(|e| ChainError::Transport(format!("commit send: {e}")))?
            .get_receipt()
            .await
            .map_err(|e| ChainError::Transport(format!("commit receipt: {e}")))?;

        Ok(receipt.transaction_hash)
    }

    pub async fn reveal(
        &self,
        game_id: [u8; 32],
        word_index: usize,
        salt: [u8; 32],
    ) -> Result<FixedBytes<32>, ChainError> {
        let provider = self.build_provider()?;
        let contract = IWordCommitment::new(self.commitment_address, &provider);

        let receipt = contract
            .reveal(game_id.into(), U256::from(word_index), salt.into())
            .send()
            .await
            .map_err(|e| ChainError::Transport(format!("reveal send: {e}")))?
            .get_receipt()
            .await
            .map_err(|e| ChainError::Transport(format!("reveal receipt: {e}")))?;

        Ok(receipt.transaction_hash)
    }

    /// Signs a resolution message matching the escrow contract's ECDSA verification.
    /// Returns a 65-byte signature (r ++ s ++ v).
    pub async fn sign_resolution(
        &self,
        game_id: [u8; 32],
        winners: &[Address],
        amounts: &[U256],
    ) -> Result<Bytes, ChainError> {
        // abi.encode(gameId, winners, amounts) — matches Solidity's encoding
        let encoded = (
            FixedBytes::<32>::from(game_id),
            winners.to_vec(),
            amounts.to_vec(),
        )
            .abi_encode();
        let hash = keccak256(&encoded);

        // sign_message applies the EIP-191 prefix, matching
        // MessageHashUtils.toEthSignedMessageHash in the contract
        let sig = self
            .signer
            .sign_message(hash.as_slice())
            .await
            .map_err(|e| ChainError::Signing(format!("{e}")))?;

        Ok(Bytes::from(sig.as_bytes().to_vec()))
    }

    pub async fn resolve_escrow(
        &self,
        game_id: [u8; 32],
        winners: Vec<Address>,
        amounts: Vec<U256>,
        signature: Bytes,
    ) -> Result<FixedBytes<32>, ChainError> {
        let escrow = self
            .escrow_address
            .ok_or_else(|| ChainError::Config("ESCROW_ADDRESS not set".into()))?;
        let provider = self.build_provider()?;
        let contract = IWordCirclesEscrow::new(escrow, &provider);

        let receipt = contract
            .resolve(game_id.into(), winners, amounts, signature)
            .send()
            .await
            .map_err(|e| ChainError::Transport(format!("resolve send: {e}")))?
            .get_receipt()
            .await
            .map_err(|e| ChainError::Transport(format!("resolve receipt: {e}")))?;

        Ok(receipt.transaction_hash)
    }

    fn build_provider(&self) -> Result<impl alloy::providers::Provider, ChainError> {
        let url: url::Url = self
            .rpc_url
            .parse()
            .map_err(|e| ChainError::Config(format!("invalid RPC URL: {e}")))?;
        let wallet = EthereumWallet::from(self.signer.clone());
        Ok(ProviderBuilder::new().wallet(wallet).connect_http(url))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::address;

    fn test_client() -> ResolverClient {
        // Same key pattern as Solidity tests (0xA11CE)
        let signer: PrivateKeySigner =
            "0x00000000000000000000000000000000000000000000000000000000000A11CE"
                .parse()
                .unwrap();
        ResolverClient {
            signer,
            rpc_url: "http://localhost:8545".into(),
            commitment_address: Address::ZERO,
            escrow_address: None,
            stats_address: None,
        }
    }

    #[tokio::test]
    async fn sign_resolution_produces_65_byte_signature() {
        let client = test_client();
        let game_id = keccak256(b"game-1");
        let winners = vec![address!("0x0000000000000000000000000000000000000001")];
        let amounts = vec![U256::from(1000)];

        let sig = client
            .sign_resolution(game_id.into(), &winners, &amounts)
            .await
            .unwrap();
        assert_eq!(sig.len(), 65, "signature must be 65 bytes (r + s + v)");
    }

    #[tokio::test]
    async fn sign_resolution_recovers_to_resolver_address() {
        let client = test_client();
        let game_id = keccak256(b"game-1");
        let winners = vec![address!("0x0000000000000000000000000000000000000001")];
        let amounts = vec![U256::from(1000)];

        let sig_bytes = client
            .sign_resolution(game_id.into(), &winners, &amounts)
            .await
            .unwrap();

        // Reconstruct the hash the same way the contract does
        let encoded = (game_id, winners.clone(), amounts.clone()).abi_encode();
        let hash = keccak256(&encoded);

        let sig = alloy::signers::Signature::try_from(sig_bytes.as_ref()).unwrap();
        let recovered = sig.recover_address_from_msg(hash.as_slice()).unwrap();
        assert_eq!(recovered, client.address());
    }

    #[tokio::test]
    async fn sign_resolution_is_deterministic() {
        let client = test_client();
        let game_id = keccak256(b"game-42");
        let winners = vec![address!("0x0000000000000000000000000000000000000001")];
        let amounts = vec![U256::from(500)];

        let sig1 = client
            .sign_resolution(game_id.into(), &winners, &amounts)
            .await
            .unwrap();
        let sig2 = client
            .sign_resolution(game_id.into(), &winners, &amounts)
            .await
            .unwrap();
        assert_eq!(sig1, sig2);
    }

    #[test]
    fn address_derived_from_key() {
        let client = test_client();
        assert_ne!(client.address(), Address::ZERO);
    }
}
