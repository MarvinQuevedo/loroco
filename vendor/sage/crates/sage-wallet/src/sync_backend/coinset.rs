//! [`SyncBackend`] implementation backed by Chia full-node RPC over HTTPS.
//!
//! Wraps [`chia_wallet_sdk::coinset::CoinsetClient`] — that client (already part of
//! chia-wallet-sdk 0.33+) implements the [`ChiaRpcClient`] trait targeting
//! `api.coinset.org`. We translate its `CoinRecord` results into the
//! [`CoinState`] shape the rest of `sage-wallet` consumes from
//! [`crate::WalletPeer`], so the [`SyncBackend`] surface stays uniform.
//!
//! Targets `api.coinset.org` (mainnet) / `testnet11.api.coinset.org` by
//! default. The base URL is configurable so users can point at FireAcademy.io
//! Leaflet or a self-hosted Chia full node fronted by a CORS-friendly proxy.
//!
//! ## What this backend can NOT replicate vs. peer sync
//!
//! * Real-time subscription pushes (`CoinStateUpdate`) — `subscribe_*` methods
//!   here just return the initial state; the polling loop in
//!   [`crate::SyncManager`] is responsible for periodically re-querying.
//! * Reorg notifications with a fork point — callers must defensively re-pull
//!   the last ~32 blocks of state.
//! * Mempool push events — pending transactions are tracked by polling
//!   `get_mempool_item_by_tx_id`.

use chia_wallet_sdk::{
    chia::protocol::{
        CoinStateFilters, RespondPeers, RespondPuzzleState, TransactionAck,
    },
    coinset::{ChiaRpcClient, CoinRecord, CoinsetClient},
    prelude::*,
};

use crate::WalletError;

use super::SyncBackend;

#[derive(Debug, Clone)]
pub struct CoinsetBackend {
    client: CoinsetClient,
}

impl CoinsetBackend {
    pub fn mainnet() -> Self {
        Self {
            client: CoinsetClient::mainnet(),
        }
    }

    pub fn testnet11() -> Self {
        Self {
            client: CoinsetClient::testnet11(),
        }
    }

    pub fn with_base_url(base_url: String) -> Self {
        Self {
            client: CoinsetClient::new(base_url),
        }
    }

    pub fn client(&self) -> &CoinsetClient {
        &self.client
    }

    pub fn base_url(&self) -> &str {
        self.client.base_url()
    }
}

impl Default for CoinsetBackend {
    fn default() -> Self {
        Self::mainnet()
    }
}

/// Translate a coinset `CoinRecord` into a `CoinState` matching the wallet
/// protocol's representation.
fn coin_record_to_state(rec: CoinRecord) -> CoinState {
    CoinState {
        coin: rec.coin,
        created_height: Some(rec.confirmed_block_index),
        spent_height: if rec.spent {
            Some(rec.spent_block_index)
        } else {
            None
        },
    }
}

fn map_rpc_err(e: reqwest::Error) -> WalletError {
    // TODO: refine — coinset's API returns errors as a JSON body (`error` field)
    // rather than HTTP status codes for most failure cases. Once we surface
    // them via models we can pick a more precise WalletError variant.
    WalletError::Request(e)
}

impl SyncBackend for CoinsetBackend {
    async fn fetch_coin(
        &self,
        coin_id: Bytes32,
        genesis_challenge: Bytes32,
    ) -> Result<CoinState, WalletError> {
        let _ = genesis_challenge; // not needed for an HTTP backend
        let res = self
            .client
            .get_coin_record_by_name(coin_id)
            .await
            .map_err(map_rpc_err)?;
        let rec = res
            .coin_record
            .ok_or_else(|| WalletError::MissingCoin(coin_id))?;
        Ok(coin_record_to_state(rec))
    }

    async fn fetch_optional_coin(
        &self,
        coin_id: Bytes32,
        _genesis_challenge: Bytes32,
    ) -> Result<Option<CoinState>, WalletError> {
        let res = self
            .client
            .get_coin_record_by_name(coin_id)
            .await
            .map_err(map_rpc_err)?;
        Ok(res.coin_record.map(coin_record_to_state))
    }

    async fn fetch_coins(
        &self,
        coin_ids: Vec<Bytes32>,
        _genesis_challenge: Bytes32,
    ) -> Result<Vec<CoinState>, WalletError> {
        if coin_ids.is_empty() {
            return Ok(Vec::new());
        }
        let res = self
            .client
            .get_coin_records_by_names(coin_ids, None, None, Some(true))
            .await
            .map_err(map_rpc_err)?;
        Ok(res
            .coin_records
            .unwrap_or_default()
            .into_iter()
            .map(coin_record_to_state)
            .collect())
    }

    async fn fetch_puzzle_solution(
        &self,
        coin_id: Bytes32,
        spent_height: u32,
    ) -> Result<(Program, Program), WalletError> {
        let res = self
            .client
            .get_puzzle_and_solution(coin_id, Some(spent_height))
            .await
            .map_err(map_rpc_err)?;
        let spend = res
            .coin_solution
            .ok_or_else(|| WalletError::MissingSpend(coin_id))?;
        Ok((spend.puzzle_reveal, spend.solution))
    }

    async fn fetch_coin_spend(
        &self,
        coin_id: Bytes32,
        genesis_challenge: Bytes32,
    ) -> Result<CoinSpend, WalletError> {
        let coin_state = self.fetch_coin(coin_id, genesis_challenge).await?;
        let spent_height = coin_state
            .spent_height
            .ok_or(WalletError::PeerMisbehaved)?;
        let (puzzle_reveal, solution) =
            self.fetch_puzzle_solution(coin_id, spent_height).await?;
        Ok(CoinSpend::new(coin_state.coin, puzzle_reveal, solution))
    }

    async fn fetch_optional_coin_spend(
        &self,
        coin_id: Bytes32,
        genesis_challenge: Bytes32,
    ) -> Result<Option<CoinSpend>, WalletError> {
        let Some(coin_state) = self.fetch_optional_coin(coin_id, genesis_challenge).await? else {
            return Ok(None);
        };
        let spent_height = coin_state
            .spent_height
            .ok_or(WalletError::PeerMisbehaved)?;
        let (puzzle_reveal, solution) =
            self.fetch_puzzle_solution(coin_id, spent_height).await?;
        Ok(Some(CoinSpend::new(
            coin_state.coin,
            puzzle_reveal,
            solution,
        )))
    }

    async fn try_fetch_singleton_child(
        &self,
        coin_id: Bytes32,
    ) -> Result<Option<CoinState>, WalletError> {
        let res = self
            .client
            .get_coin_records_by_parent_ids(vec![coin_id], None, None, Some(true))
            .await
            .map_err(map_rpc_err)?;
        Ok(res
            .coin_records
            .unwrap_or_default()
            .into_iter()
            .find(|r| r.coin.amount % 2 == 1)
            .map(coin_record_to_state))
    }

    async fn send_transaction(
        &self,
        spend_bundle: SpendBundle,
    ) -> Result<TransactionAck, WalletError> {
        let res = self
            .client
            .push_tx(spend_bundle)
            .await
            .map_err(map_rpc_err)?;

        // TODO: convert (status, error) into the correct TransactionAck shape
        // for sage. Coinset returns: status = "SUCCESS" | "PENDING" | "FAILED".
        // chia_protocol::TransactionAck currently is a placeholder until we
        // resolve the exact field layout we want to surface (it's used by the
        // queue dispatcher in sage-wallet/src/queues).
        let _ = res;
        todo!("CoinsetBackend::send_transaction — synthesize a TransactionAck")
    }

    async fn unsubscribe(&self) -> Result<(), WalletError> {
        Ok(())
    }

    async fn subscribe_coins(
        &self,
        coin_ids: Vec<Bytes32>,
        _previous_height: Option<u32>,
        _header_hash: Bytes32,
    ) -> Result<Vec<CoinState>, WalletError> {
        // Subscriptions don't exist on an HTTP backend — return the initial
        // state and let the SyncManager polling loop re-query on every tick.
        self.fetch_coins(coin_ids, Bytes32::default()).await
    }

    async fn subscribe_puzzles(
        &self,
        _puzzle_hashes: Vec<Bytes32>,
        _previous_height: Option<u32>,
        _header_hash: Bytes32,
        _filters: CoinStateFilters,
    ) -> Result<RespondPuzzleState, WalletError> {
        // Initial state via get_coin_records_by_puzzle_hashes; subscription is
        // tracked locally so the polling loop knows which PHs to re-query.
        // The RespondPuzzleState shape includes a coin_states list + fork_point
        // we'll need to synthesize. Wire-up deferred until SyncManager is
        // refactored to drive this trait.
        todo!(
            "CoinsetBackend::subscribe_puzzles — wire to get_coin_records_by_puzzle_hashes \
             and synthesize a RespondPuzzleState"
        )
    }

    async fn unsubscribe_coins(&self, _coin_ids: Vec<Bytes32>) -> Result<(), WalletError> {
        Ok(())
    }

    async fn block_timestamp(&self, height: u32) -> Result<(Bytes32, u64), WalletError> {
        let res = self
            .client
            .get_block_record_by_height(height)
            .await
            .map_err(map_rpc_err)?;
        // TODO: extract header_hash + timestamp once we map GetBlockRecordResponse.
        let _ = res;
        todo!("CoinsetBackend::block_timestamp — extract header_hash + timestamp from block_record")
    }

    async fn request_peers(&self) -> Result<RespondPeers, WalletError> {
        Ok(RespondPeers::new(Vec::new()))
    }
}
