# Contract deployment and verification for Gnosis chain.
#
# Setup (one-time):
#   cast wallet import deployer --interactive
#   cast wallet import resolver --interactive
#
# Create a .env file with:
#   RPC_URL             — Gnosis RPC endpoint
#
# Verify (after deployment, add to .env):
#   GNOSISSCAN_API_KEY  — API key from gnosisscan.io
#   ESCROW_ADDRESS      — deployed WordCirclesEscrow address
#   STATS_ADDRESS       — deployed WordCircleStats address
#   COMMITMENT_ADDRESS  — deployed WordCommitment address

-include .env

DEPLOYER_ACCOUNT ?= deployer
RESOLVER_ACCOUNT ?= resolver

DEPLOYER_ADDRESS := $(shell cast wallet address --account $(DEPLOYER_ACCOUNT) 2>/dev/null)
RESOLVER_ADDRESS := $(shell cast wallet address --account $(RESOLVER_ACCOUNT) 2>/dev/null)
VERIFY_FLAG      := $(if $(GNOSISSCAN_API_KEY),--verify,)

.PHONY: deploy deploy-escrow verify-all openapi release-ipfs

# Upload a built DAppNode package release directory to IPFS and record the
# resulting (installable) directory hash in deployment/releases.json. Needs VPN
# to the dappnode (default IPFS_API) and a local build dir from `dappnodesdk
# build` (or the CI artifact unpacked into deployment/build_<name>_<ver>/).
# Review + commit the releases.json change afterward.
#   make release-ipfs VERSION=0.6.2
#   make release-ipfs VERSION=0.6.2 DIR=deployment/build_word-circles.public.dappnode.eth_0.6.2
release-ipfs:
	@VERSION=$(VERSION) DIR=$(DIR) IPFS_API=$(IPFS_API) deployment/upload-ipfs.sh

# Refresh the committed OpenAPI snapshot from the backend, then regenerate the
# frontend TypeScript types. Run after changing any API handler or schema.
openapi:
	cd backend && cargo run --quiet --bin dump_openapi > ../src/lib/api/openapi.json
	bun run gen:api

deploy:
	@echo "Deployer:  $(DEPLOYER_ADDRESS)"
	@echo "Resolver:  $(RESOLVER_ADDRESS)"
	DEPLOYER_ADDRESS=$(DEPLOYER_ADDRESS) RESOLVER_ADDRESS=$(RESOLVER_ADDRESS) \
		forge script script/Deploy.s.sol:DeployScript \
		--rpc-url $(RPC_URL) \
		--account $(DEPLOYER_ACCOUNT) \
		--broadcast $(VERIFY_FLAG)

# Redeploy ONLY the escrow (e.g. to fix the ERC20Lift). Leaves Stats/Commitment
# untouched. Set ERC20_LIFT to override the default (live Hub lift).
deploy-escrow:
	@echo "Deployer:  $(DEPLOYER_ADDRESS)"
	DEPLOYER_ADDRESS=$(DEPLOYER_ADDRESS) \
		forge script script/DeployEscrow.s.sol:DeployEscrowScript \
		--rpc-url $(RPC_URL) \
		--account $(DEPLOYER_ACCOUNT) \
		--broadcast $(VERIFY_FLAG)

verify-all:
	@echo "Verifying contracts on Gnosisscan..."
	forge verify-contract $(ESCROW_ADDRESS) contracts/WordCirclesEscrow.sol:WordCirclesEscrow \
		--chain 100 --watch
	forge verify-contract $(STATS_ADDRESS) contracts/WordCircleStats.sol:WordCircleStats \
		--chain 100 --watch \
		--constructor-args $$(cast abi-encode "constructor(address,address)" $(DEPLOYER_ADDRESS) $(RESOLVER_ADDRESS))
	forge verify-contract $(COMMITMENT_ADDRESS) contracts/WordCommitment.sol:WordCommitment \
		--chain 100 --watch \
		--constructor-args $$(cast abi-encode "constructor(address,address,bytes32,string)" \
			$(DEPLOYER_ADDRESS) $(RESOLVER_ADDRESS) \
			0xed01643704d9284f12c5b5fb16717cffa1a2cf4ed0cc01ac6274bc63df2b266a \
			"ipfs://QmWaw2pGNQJqQmyWTeoaAJcMygUdSj69Dxq8v422HjmPBa")
