mod action_system;
mod actions;
mod data;
mod keys;
mod offers;
mod settings;
mod transactions;

pub use action_system::*;
pub use actions::*;
pub use data::*;
pub use keys::*;
pub use offers::*;
pub use settings::*;
pub use transactions::*;

pub mod wallet_connect;

// The 5 WalletConnect endpoints are dispatched like any other endpoint
// (sage_api::<Endpoint>), so their request/response types must be reachable
// at the crate root too. Re-exported explicitly (not glob) to avoid
// colliding with helper types like Coin/CoinSpend/SpendBundle.
pub use wallet_connect::{
    FilterUnlockedCoins, FilterUnlockedCoinsResponse, GetAssetCoins,
    GetAssetCoinsResponse, SendTransactionImmediately,
    SendTransactionImmediatelyResponse, SignMessageByAddress,
    SignMessageByAddressResponse, SignMessageWithPublicKey,
    SignMessageWithPublicKeyResponse,
};
