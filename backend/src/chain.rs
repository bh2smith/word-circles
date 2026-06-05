use alloy::{
    network::EthereumWallet,
    primitives::{Address, Bytes, FixedBytes, U256, keccak256},
    providers::ProviderBuilder,
    signers::{Signer, local::PrivateKeySigner},
    sol,
    sol_types::SolValue,
};
use serde::{Deserialize, Serialize};
use std::fmt;

/// A single PvP lobby: one Circles group's wrapper token and stake. The escrow
/// is group-agnostic, so each lobby is an independent `(resolver, token, amount,
/// capacity)` bucket keyed on the wrapper token.
#[derive(Clone, Serialize, utoipa::ToSchema)]
pub struct LobbyConfig {
    /// Human-readable group name, e.g. "Gnosis".
    pub name: String,
    /// Group avatar address. Intersected with a player's Circles group
    /// memberships to decide whether the lobby is shown to them.
    pub group: String,
    /// s-gCRC wrapper token a player stakes to join this lobby.
    pub token: String,
    /// Per-player stake (wei, as a decimal string) for `escrow.join`.
    pub amount: String,
    /// Number of players per PvP game (the escrow lobby capacity).
    pub capacity: u32,
    /// Live: the bot Safe holds ≥ 2× `amount` of `token` (headroom so two
    /// simultaneous joiners are both covered). Stamped per-request from shared
    /// state the bot refreshes each tick; `false` until the first tick.
    #[serde(rename = "botFunded")]
    pub bot_funded: bool,
}

#[derive(Clone, Serialize, utoipa::ToSchema)]
pub struct ContractConfig {
    pub resolver: String,
    #[serde(rename = "commitmentAddress")]
    pub commitment_address: String,
    #[serde(rename = "statsAddress", skip_serializing_if = "Option::is_none")]
    pub stats_address: Option<String>,
    #[serde(rename = "escrowAddress", skip_serializing_if = "Option::is_none")]
    pub escrow_address: Option<String>,
    #[serde(rename = "pvpEnabled")]
    pub pvp_enabled: bool,
    /// Per-player play window before a forced timeout, in seconds.
    #[serde(rename = "timeoutSecs", skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u32>,
    /// Configured PvP lobbies (one per supported group). The frontend shows the
    /// ones the player is a group member of; each lobby's `botFunded` flag drives
    /// a "no bot backstop" warning rather than hiding the lobby.
    pub lobbies: Vec<LobbyConfig>,
}

/// Static lobby definition parsed from the `PVP_LOBBIES` env JSON, before the
/// live `bot_funded` flag is layered on. Held by `ResolverClient` and the bot.
#[derive(Clone)]
pub struct Lobby {
    pub name: String,
    pub group: Address,
    pub token: Address,
    pub amount: U256,
    pub capacity: u32,
}

/// JSON shape of one entry in the `PVP_LOBBIES` env var (hand-written into
/// Dappnode/Vercel settings). `capacity` defaults to 2 if omitted.
#[derive(Deserialize)]
struct LobbyEnv {
    name: String,
    group: String,
    token: String,
    amount: String,
    #[serde(default = "default_capacity")]
    capacity: u32,
}

fn default_capacity() -> u32 {
    2
}

impl Lobby {
    /// Parses `PVP_LOBBIES` (a JSON array). Returns an empty list (logging the
    /// reason) when unset or malformed — PvP then degrades to "no lobbies".
    pub fn from_env() -> Vec<Lobby> {
        let Ok(raw) = std::env::var("PVP_LOBBIES") else {
            return Vec::new();
        };
        Self::parse(&raw)
    }

    /// Parses the `PVP_LOBBIES` JSON. Malformed JSON logs and yields an empty
    /// list; individual entries with an unparseable address are skipped (logged).
    ///
    /// Entries with `capacity != 2` are also skipped (logged): settlement
    /// (`settlement::determine_winner`) and the PvP UI are hardcoded to two
    /// players, so a `capacity >= 3` lobby would create on-chain games that
    /// mis-settle (3rd+ player stakes but can never win). Rejecting at parse
    /// time prevents that footgun until true N-player support lands (#151).
    pub fn parse(raw: &str) -> Vec<Lobby> {
        let parsed: Vec<LobbyEnv> = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(e) => {
                tracing::error!("PVP_LOBBIES is not valid JSON: {e}");
                return Vec::new();
            }
        };
        parsed
            .into_iter()
            .filter_map(|l| {
                if l.capacity != 2 {
                    tracing::error!(
                        lobby = %l.name,
                        capacity = l.capacity,
                        "PVP_LOBBIES entry has capacity != 2 — skipped (only 2-player games are supported)"
                    );
                    return None;
                }
                match (l.group.parse(), l.token.parse(), l.amount.parse()) {
                    (Ok(group), Ok(token), Ok(amount)) => Some(Lobby {
                        name: l.name,
                        group,
                        token,
                        amount,
                        capacity: l.capacity,
                    }),
                    _ => {
                        tracing::error!(lobby = %l.name, "PVP_LOBBIES entry has an invalid address/amount — skipped");
                        None
                    }
                }
            })
            .collect()
    }
}

/// Lowercase 0x hex of an address, the canonical key for the bot's funded-set
/// and the `get_config` lookup so the two always agree on casing.
pub fn token_key(addr: &Address) -> String {
    format!("{addr:#x}")
}

/// Shared set of bot-funded lobby tokens (lowercase 0x hex keys, see
/// [`token_key`]). The bot writes it each tick; `get_config` reads it to stamp
/// each lobby's live `bot_funded` flag — keeping the on-chain balance read off
/// the `/api/config` request path.
pub type FundedSet = std::sync::Arc<std::sync::RwLock<std::collections::HashSet<String>>>;

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

    // Circles BaseGroup: the owner/service trusts members so they can mint the
    // group token. We call this as the group's `service` (the resolver EOA, set
    // via setService by the group owner).
    #[sol(rpc)]
    interface IBaseGroup {
        function trust(address trustReceiver, uint96 expiry) external;
    }

    // Circles v2 Hub: membership = the group trusts the member (with a live
    // expiry). Used to skip re-trusting an existing member.
    #[sol(rpc)]
    interface IHub {
        function isTrusted(address truster, address trustReceiver) external view returns (bool);
    }

    // ERC-1271: Circles avatars are Safes, so a "signed by the player" proof is a
    // contract signature verified by the avatar itself, not ecrecover.
    #[sol(rpc)]
    interface IERC1271 {
        function isValidSignature(bytes32 hash, bytes signature) external view returns (bytes4);
    }
}

/// ERC-1271 magic value returned by `isValidSignature` for a valid signature.
const ERC1271_MAGIC: [u8; 4] = [0x16, 0x26, 0xba, 0x7e];

/// Circles v2 Hub on Gnosis. Used to check existing group membership before
/// trusting (idempotency).
pub const HUB_ADDRESS: &str = "0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8";

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
    pub lobbies: Vec<Lobby>,
    /// Circles BaseGroup the app onboards players into (e.g. WordGames). The
    /// resolver EOA must be the group's owner/service to trust members.
    pub group_address: Option<Address>,
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
        let lobbies = Lobby::from_env();
        let group_address = std::env::var("GROUP_ADDRESS")
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
            lobbies,
            group_address,
        })
    }

    pub fn address(&self) -> Address {
        self.signer.address()
    }

    /// Builds the base config. Each lobby's `bot_funded` starts `false`;
    /// `get_config` stamps the live value per-request from the bot's funded-set.
    pub fn config(&self, pvp_enabled: bool, timeout_secs: u32) -> ContractConfig {
        let lobbies = self
            .lobbies
            .iter()
            .map(|l| LobbyConfig {
                name: l.name.clone(),
                group: token_key(&l.group),
                token: token_key(&l.token),
                amount: l.amount.to_string(),
                capacity: l.capacity,
                bot_funded: false,
            })
            .collect();
        ContractConfig {
            resolver: self.signer.address().to_string(),
            commitment_address: self.commitment_address.to_string(),
            stats_address: self.stats_address.map(|a| a.to_string()),
            escrow_address: self.escrow_address.map(|a| a.to_string()),
            pvp_enabled,
            timeout_secs: Some(timeout_secs),
            lobbies,
        }
    }

    /// Verifies `signature` over `message` was produced by `player`. Circles
    /// avatars are Safes, so this tries plain ECDSA recovery first (cheap, for an
    /// EOA player) and falls back to an on-chain ERC-1271 `isValidSignature`
    /// check against the player contract (the miniapp/Safe case). The message is
    /// EIP-191 prefix-hashed (matching the miniapp host's `erc1271` signing).
    pub async fn verify_player_signature(
        &self,
        player: Address,
        message: &str,
        signature: &[u8],
    ) -> Result<bool, ChainError> {
        // Fast path: EOA ECDSA recovery (applies the EIP-191 prefix internally).
        if let Ok(sig) = alloy::signers::Signature::try_from(signature) {
            if let Ok(recovered) = sig.recover_address_from_msg(message.as_bytes()) {
                if recovered == player {
                    return Ok(true);
                }
            }
        }

        // Safe / contract wallet: ERC-1271 against the EIP-191 hash.
        let hash = alloy::primitives::eip191_hash_message(message.as_bytes());
        let provider = self.build_provider()?;
        let contract = IERC1271::new(player, &provider);
        match contract
            .isValidSignature(hash, Bytes::from(signature.to_vec()))
            .call()
            .await
        {
            Ok(magic) => Ok(magic.as_slice() == ERC1271_MAGIC),
            // No code at the address / revert ⇒ not a valid contract signer.
            Err(_) => Ok(false),
        }
    }

    /// Whether the onboarding group already trusts `member` (live membership).
    pub async fn is_group_member(&self, member: Address) -> Result<bool, ChainError> {
        let group = self
            .group_address
            .ok_or_else(|| ChainError::Config("GROUP_ADDRESS not set".into()))?;
        let hub: Address = HUB_ADDRESS
            .parse()
            .map_err(|e| ChainError::Config(format!("invalid HUB_ADDRESS: {e}")))?;
        let provider = self.build_provider()?;
        let contract = IHub::new(hub, &provider);
        contract
            .isTrusted(group, member)
            .call()
            .await
            .map_err(|e| ChainError::Transport(format!("isTrusted: {e}")))
    }

    /// Trusts `member` into the onboarding group (indefinite expiry) so they can
    /// mint the group token and the PvP lobby becomes visible to them. Idempotent:
    /// returns `Ok(None)` without a tx if they're already a member. Called as the
    /// group's service (the resolver EOA), so the group owner must have run
    /// `setService(resolver)` first.
    pub async fn trust_group_member(
        &self,
        member: Address,
    ) -> Result<Option<FixedBytes<32>>, ChainError> {
        if self.is_group_member(member).await? {
            return Ok(None);
        }
        let group = self
            .group_address
            .ok_or_else(|| ChainError::Config("GROUP_ADDRESS not set".into()))?;
        let provider = self.build_provider()?;
        let contract = IBaseGroup::new(group, &provider);
        // type(uint96).max — the indefinite expiry the group's other members use.
        let expiry = alloy::primitives::aliases::U96::MAX;
        let receipt = contract
            .trust(member, expiry)
            .send()
            .await
            .map_err(|e| ChainError::Transport(format!("trust send: {e}")))?
            .get_receipt()
            .await
            .map_err(|e| ChainError::Transport(format!("trust receipt: {e}")))?;
        Ok(Some(receipt.transaction_hash))
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
        // abi.encode(gameId, winners, amounts). Use abi_encode_params, NOT
        // abi_encode: for a multi-value tuple with dynamic members, abi_encode
        // wraps it and prepends a 0x20 offset, so its keccak differs from
        // Solidity's `abi.encode(a, b, c)`. The contract recovers against the
        // unwrapped encoding, so abi_encode here makes the signature recover to
        // the wrong address (InvalidSignature on resolve).
        let encoded = (
            FixedBytes::<32>::from(game_id),
            winners.to_vec(),
            amounts.to_vec(),
        )
            .abi_encode_params();
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
            lobbies: Vec::new(),
            group_address: None,
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

        // Reconstruct the hash the way the CONTRACT does: abi.encode(...) ==
        // abi_encode_params (no wrapping offset). The encoding must start with the
        // gameId, not a 0x20 offset — guarding against a regression to abi_encode,
        // which would make the on-chain recover reject with InvalidSignature.
        let encoded = (game_id, winners.clone(), amounts.clone()).abi_encode_params();
        assert_eq!(
            &encoded[..32],
            game_id.as_slice(),
            "abi.encode must start with gameId (no leading offset)"
        );
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

    #[test]
    fn parses_pvp_lobbies_json() {
        let raw = r#"[
            {"name":"Gnosis","group":"0xc19bc204eb1c1d5b3fe500e5e5dfabab625f286c","token":"0xeeF7B1f06B092625228C835Dd5D5B14641D1e54A","amount":"100000000000000000","capacity":2},
            {"name":"Berlin Full Node","group":"0xeb614ef61367687704cd4628a68a02f3b10ce68c","token":"0x0d8c4901Dd270Fe101B8014A5dbECC4e4432eB1E","amount":"100000000000000000"}
        ]"#;
        let lobbies = Lobby::parse(raw);
        assert_eq!(lobbies.len(), 2);
        assert_eq!(lobbies[0].name, "Gnosis");
        assert_eq!(lobbies[0].capacity, 2);
        // capacity defaults to 2 when omitted.
        assert_eq!(lobbies[1].capacity, 2);
        assert_eq!(lobbies[1].amount, U256::from(100_000_000_000_000_000u128));
        // Addresses are lowercased by token_key for the funded-set / membership keys.
        assert_eq!(
            token_key(&lobbies[0].token),
            "0xeef7b1f06b092625228c835dd5d5b14641d1e54a"
        );
    }

    #[test]
    fn invalid_lobbies_json_yields_empty() {
        assert!(Lobby::parse("not json").is_empty());
        // A bad address in one entry drops just that entry.
        let raw = r#"[{"name":"Bad","group":"0xnothex","token":"0xeeF7B1f06B092625228C835Dd5D5B14641D1e54A","amount":"1"}]"#;
        assert!(Lobby::parse(raw).is_empty());
    }

    #[test]
    fn lobbies_with_unsupported_capacity_are_skipped() {
        // capacity != 2 is a footgun: settlement + UI only handle two players,
        // so such a lobby would mis-settle. Drop just the offending entry, keep
        // the valid 2-player one.
        let raw = r#"[
            {"name":"ThreeWay","group":"0xc19bc204eb1c1d5b3fe500e5e5dfabab625f286c","token":"0xeeF7B1f06B092625228C835Dd5D5B14641D1e54A","amount":"1","capacity":3},
            {"name":"Gnosis","group":"0xc19bc204eb1c1d5b3fe500e5e5dfabab625f286c","token":"0xeeF7B1f06B092625228C835Dd5D5B14641D1e54A","amount":"1","capacity":2}
        ]"#;
        let lobbies = Lobby::parse(raw);
        assert_eq!(lobbies.len(), 1);
        assert_eq!(lobbies[0].name, "Gnosis");
        // A solo capacity-1 entry is likewise rejected, yielding no lobbies.
        let solo = r#"[{"name":"Solo","group":"0xc19bc204eb1c1d5b3fe500e5e5dfabab625f286c","token":"0xeeF7B1f06B092625228C835Dd5D5B14641D1e54A","amount":"1","capacity":1}]"#;
        assert!(Lobby::parse(solo).is_empty());
    }

    #[tokio::test]
    async fn verify_player_signature_accepts_eoa_self_sign() {
        let client = test_client();
        let player = client.address();
        let message = "Join Word Circles PvP group\nAddress: 0xabc";
        let sig = client
            .signer
            .sign_message(message.as_bytes())
            .await
            .unwrap();
        let ok = client
            .verify_player_signature(player, message, &sig.as_bytes())
            .await
            .unwrap();
        assert!(ok, "an address's own EIP-191 signature must verify");
    }

    #[tokio::test]
    async fn verify_player_signature_rejects_other_signer_via_ecdsa() {
        // A signature by the test key must NOT verify for a different EOA. (The
        // ERC-1271 fallback returns false when the address has no contract code.)
        let client = test_client();
        let other = address!("0x000000000000000000000000000000000000beef");
        let message = "Join Word Circles PvP group\nAddress: 0xbeef";
        let sig = client
            .signer
            .sign_message(message.as_bytes())
            .await
            .unwrap();
        let ok = client
            .verify_player_signature(other, message, &sig.as_bytes())
            .await
            .unwrap();
        assert!(!ok, "a mismatched signer must not verify");
    }

    #[test]
    fn config_stamps_lobbies_unfunded_by_default() {
        let mut client = test_client();
        client.lobbies = Lobby::parse(
            r#"[{"name":"Gnosis","group":"0xc19bc204eb1c1d5b3fe500e5e5dfabab625f286c","token":"0xeeF7B1f06B092625228C835Dd5D5B14641D1e54A","amount":"100000000000000000","capacity":2}]"#,
        );
        let config = client.config(true, 10_800);
        assert_eq!(config.lobbies.len(), 1);
        assert_eq!(config.lobbies[0].name, "Gnosis");
        // bot_funded is stamped live by get_config; the base is always false.
        assert!(!config.lobbies[0].bot_funded);
        // group/token serialized as lowercase 0x hex (matches the funded-set key
        // and the frontend membership intersection).
        assert_eq!(
            config.lobbies[0].token,
            "0xeef7b1f06b092625228c835dd5d5b14641d1e54a"
        );
    }
}
