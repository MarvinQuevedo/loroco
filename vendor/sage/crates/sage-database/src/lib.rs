#[cfg(feature = "sqlite")]
mod maintenance;
mod serialized_primitives;
mod tables;
mod utils;

#[cfg(feature = "sqlite")]
pub use maintenance::*;
pub use serialized_primitives::*;
pub use tables::*;

pub(crate) use utils::*;

use std::num::TryFromIntError;

#[cfg(feature = "sqlite")]
use sqlx::{Sqlite, SqlitePool, Transaction as SqliteTransaction};
use thiserror::Error;
#[cfg(feature = "sqlite")]
use tracing::info;

// ─── SQLite-backed implementation ──────────────────────────────────────────

#[cfg(feature = "sqlite")]
#[derive(Debug, Clone)]
pub struct Database {
    pub(crate) pool: SqlitePool,
}

#[cfg(feature = "sqlite")]
impl Database {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn tx(&self) -> Result<DatabaseTx<'_>> {
        let tx = self.pool.begin().await?;
        Ok(DatabaseTx::new(tx))
    }

    pub async fn run_rust_migrations(&self, ticker: String) -> Result<()> {
        let mut tx = self.tx().await?;

        let version = tx.rust_migration_version().await?;

        info!("The current Sage migration version is {version}");

        if version < 1 {
            let ticker_upper = ticker.to_uppercase();
            info!("Migrating to version 1 - setting chia token ticker to {ticker_upper}");
            sqlx::query!("UPDATE assets SET ticker = ? WHERE id = 0", ticker_upper)
                .execute(&mut *tx.tx)
                .await?;
            tx.set_rust_migration_version(1).await?;
        }

        tx.commit().await?;

        Ok(())
    }
}

#[cfg(feature = "sqlite")]
#[derive(Debug)]
pub struct DatabaseTx<'a> {
    pub(crate) tx: SqliteTransaction<'a, Sqlite>,
}

#[cfg(feature = "sqlite")]
impl<'a> DatabaseTx<'a> {
    pub fn new(tx: SqliteTransaction<'a, Sqlite>) -> Self {
        Self { tx }
    }

    pub async fn commit(self) -> Result<()> {
        Ok(self.tx.commit().await?)
    }

    pub async fn rollback(self) -> Result<()> {
        Ok(self.tx.rollback().await?)
    }

    pub async fn rust_migration_version(&mut self) -> Result<i64> {
        let row = sqlx::query_scalar!("SELECT version FROM rust_migrations LIMIT 1")
            .fetch_one(&mut *self.tx)
            .await?;

        Ok(row)
    }

    pub async fn set_rust_migration_version(&mut self, version: i64) -> Result<()> {
        sqlx::query!("UPDATE rust_migrations SET version = ?", version)
            .execute(&mut *self.tx)
            .await?;

        Ok(())
    }
}

// ─── Stub implementation (no-sqlite) ───────────────────────────────────────
//
// When the `sqlite` feature is off (wasm32 builds use this), `Database` and
// `DatabaseTx` exist as opaque types whose methods are not yet wired. This
// keeps the public type names available to consumers (sage-wallet, etc.) so
// they can be plumbed through; the methods themselves will be implemented as
// JS-callback shims in a follow-up commit (IndexedDB-backed storage on the
// browser side).

#[cfg(not(feature = "sqlite"))]
#[derive(Debug, Clone, Default)]
pub struct Database {
    _private: (),
}

#[cfg(not(feature = "sqlite"))]
impl Database {
    /// Begin a transaction. Stub — returns NotImplemented until the JS-callback
    /// storage backend is wired in. The signature matches the native impl so
    /// consumers (sage-wallet, etc.) compile unchanged.
    #[allow(clippy::unused_async)]
    pub async fn tx(&self) -> Result<DatabaseTx<'_>> {
        Err(DatabaseError::NotImplemented)
    }

    #[allow(clippy::unused_async)]
    pub async fn run_rust_migrations(&self, _ticker: String) -> Result<()> {
        Err(DatabaseError::NotImplemented)
    }
}

#[cfg(not(feature = "sqlite"))]
#[derive(Debug)]
pub struct DatabaseTx<'a> {
    _private: core::marker::PhantomData<&'a ()>,
}

#[cfg(not(feature = "sqlite"))]
impl DatabaseTx<'_> {
    #[allow(clippy::unused_async)]
    pub async fn commit(self) -> Result<()> {
        Err(DatabaseError::NotImplemented)
    }

    #[allow(clippy::unused_async)]
    pub async fn rollback(self) -> Result<()> {
        Err(DatabaseError::NotImplemented)
    }
}

#[derive(Debug, Error)]
pub enum DatabaseError {
    #[cfg(feature = "sqlite")]
    #[error("SQLx error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("Precision lost during cast")]
    PrecisionLost(#[from] TryFromIntError),

    #[error("Invalid length {0}, expected {1}")]
    InvalidLength(usize, usize),

    #[error("BLS error: {0}")]
    Bls(#[from] chia_wallet_sdk::chia::bls::Error),

    #[error("Invalid enum variant")]
    InvalidEnumVariant,

    #[error("Invalid address")]
    InvalidAddress,

    #[error("Option underlying not found")]
    OptionUnderlyingNotFound,

    #[error("Public key not found for puzzle hash")]
    PublicKeyNotFound,

    #[cfg(not(feature = "sqlite"))]
    #[error("Storage backend not wired (no-sqlite stub)")]
    NotImplemented,
}

pub(crate) type Result<T> = std::result::Result<T, DatabaseError>;
