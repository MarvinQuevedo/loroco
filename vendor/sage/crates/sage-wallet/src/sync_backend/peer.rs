//! [`SyncBackend`] implementation backed by a single [`WalletPeer`].
//!
//! This is a thin pass-through: every trait method forwards to the existing
//! [`WalletPeer`] implementation with identical semantics. Existing native
//! callers can swap to `Arc<dyn SyncBackend>` without behavior changes.

use chia_wallet_sdk::{
    chia::protocol::{
        CoinStateFilters, RespondPeers, RespondPuzzleState, TransactionAck,
    },
    prelude::*,
};

use crate::{WalletError, WalletPeer};

use super::SyncBackend;

#[derive(Debug, Clone)]
pub struct PeerBackend {
    peer: WalletPeer,
}

impl PeerBackend {
    pub fn new(peer: WalletPeer) -> Self {
        Self { peer }
    }

    pub fn inner(&self) -> &WalletPeer {
        &self.peer
    }
}

impl SyncBackend for PeerBackend {
    async fn fetch_coin(
        &self,
        coin_id: Bytes32,
        genesis_challenge: Bytes32,
    ) -> Result<CoinState, WalletError> {
        self.peer.fetch_coin(coin_id, genesis_challenge).await
    }

    async fn fetch_optional_coin(
        &self,
        coin_id: Bytes32,
        genesis_challenge: Bytes32,
    ) -> Result<Option<CoinState>, WalletError> {
        self.peer
            .fetch_optional_coin(coin_id, genesis_challenge)
            .await
    }

    async fn fetch_coins(
        &self,
        coin_ids: Vec<Bytes32>,
        genesis_challenge: Bytes32,
    ) -> Result<Vec<CoinState>, WalletError> {
        self.peer.fetch_coins(coin_ids, genesis_challenge).await
    }

    async fn fetch_puzzle_solution(
        &self,
        coin_id: Bytes32,
        spent_height: u32,
    ) -> Result<(Program, Program), WalletError> {
        self.peer.fetch_puzzle_solution(coin_id, spent_height).await
    }

    async fn fetch_coin_spend(
        &self,
        coin_id: Bytes32,
        genesis_challenge: Bytes32,
    ) -> Result<CoinSpend, WalletError> {
        self.peer.fetch_coin_spend(coin_id, genesis_challenge).await
    }

    async fn fetch_optional_coin_spend(
        &self,
        coin_id: Bytes32,
        genesis_challenge: Bytes32,
    ) -> Result<Option<CoinSpend>, WalletError> {
        self.peer
            .fetch_optional_coin_spend(coin_id, genesis_challenge)
            .await
    }

    async fn try_fetch_singleton_child(
        &self,
        coin_id: Bytes32,
    ) -> Result<Option<CoinState>, WalletError> {
        self.peer.try_fetch_singleton_child(coin_id).await
    }

    async fn send_transaction(
        &self,
        spend_bundle: SpendBundle,
    ) -> Result<TransactionAck, WalletError> {
        self.peer.send_transaction(spend_bundle).await
    }

    async fn unsubscribe(&self) -> Result<(), WalletError> {
        self.peer.unsubscribe().await
    }

    async fn subscribe_coins(
        &self,
        coin_ids: Vec<Bytes32>,
        previous_height: Option<u32>,
        header_hash: Bytes32,
    ) -> Result<Vec<CoinState>, WalletError> {
        self.peer
            .subscribe_coins(coin_ids, previous_height, header_hash)
            .await
    }

    async fn subscribe_puzzles(
        &self,
        puzzle_hashes: Vec<Bytes32>,
        previous_height: Option<u32>,
        header_hash: Bytes32,
        filters: CoinStateFilters,
    ) -> Result<RespondPuzzleState, WalletError> {
        self.peer
            .subscribe_puzzles(puzzle_hashes, previous_height, header_hash, filters)
            .await
    }

    async fn unsubscribe_coins(&self, coin_ids: Vec<Bytes32>) -> Result<(), WalletError> {
        self.peer.unsubscribe_coins(coin_ids).await
    }

    async fn block_timestamp(&self, height: u32) -> Result<(Bytes32, u64), WalletError> {
        self.peer.block_timestamp(height).await
    }

    async fn request_peers(&self) -> Result<RespondPeers, WalletError> {
        self.peer.request_peers().await
    }
}
