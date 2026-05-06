mod client;
mod data;
mod wallet;

pub use client::Client;
pub use data::{DataUploadResult, FileUploadResult};
pub use wallet::Wallet;

uniffi::setup_scaffolding!();

/// Initialise logging for the native FFI.
///
/// On Android this routes `log` crate output to logcat under the `ant_ffi`
/// tag. On other platforms it's a no-op so host tests can call it unconditionally.
#[uniffi::export]
pub fn setup_logger() {
    #[cfg(target_os = "android")]
    {
        use std::sync::Once;
        static INIT: Once = Once::new();
        INIT.call_once(|| {
            android_logger::init_once(
                android_logger::Config::default()
                    .with_max_level(log::LevelFilter::Debug)
                    .with_tag("ant_ffi"),
            );
        });
    }
}

// ===== Result types =====

/// Result of storing a chunk on the network.
#[derive(uniffi::Record)]
pub struct ChunkPutResult {
    /// Hex-encoded chunk address (32 bytes).
    pub address: String,
}

/// Result of a public data upload (data map stored as public chunk).
#[derive(uniffi::Record)]
pub struct DataPutPublicResult {
    /// Hex-encoded address of the stored data map.
    pub address: String,
    /// Number of chunks stored.
    pub chunks_stored: u64,
    /// Payment mode that was used: "auto", "merkle", or "single".
    pub payment_mode_used: String,
}

/// Result of a private data upload (data map returned to caller).
#[derive(uniffi::Record)]
pub struct DataPutPrivateResult {
    /// Hex-encoded serialized data map (caller keeps this secret).
    pub data_map: String,
    /// Number of chunks stored.
    pub chunks_stored: u64,
    /// Payment mode that was used.
    pub payment_mode_used: String,
}

/// Result of uploading a file (public).
#[derive(uniffi::Record)]
pub struct FilePutPublicResult {
    /// Hex-encoded address of the stored data map.
    pub address: String,
}

/// Payment entry for external signing.
#[derive(uniffi::Record)]
pub struct PaymentEntry {
    /// Quote hash (hex, 32 bytes).
    pub quote_hash: String,
    /// Rewards address (hex with 0x prefix).
    pub rewards_address: String,
    /// Amount to pay (atto tokens as decimal string).
    pub amount: String,
}

/// Result of preparing an upload for external signing.
#[derive(uniffi::Record)]
pub struct PrepareUploadResult {
    /// Opaque handle to pass to `finalize_upload` after signing.
    pub upload_id: String,
    /// Payment entries to sign externally.
    pub payments: Vec<PaymentEntry>,
    /// Total amount across all payments (atto tokens).
    pub total_amount: String,
    /// Hex-encoded serialized DataMap for later retrieval.
    pub data_map: String,
}

/// Result of preparing a public data upload for external signing.
/// Same as `PrepareUploadResult` but returns the data-map's public address
/// (deterministic content hash) instead of the serialized data-map bytes,
/// because a public upload publishes the data-map as its own chunk.
#[derive(uniffi::Record)]
pub struct PreparePublicUploadResult {
    /// Opaque handle to pass to `finalize_public_upload` after signing.
    pub upload_id: String,
    /// Payment entries to sign externally (includes the data-map chunk).
    pub payments: Vec<PaymentEntry>,
    /// Total amount across all payments (atto tokens).
    pub total_amount: String,
    /// Hex-encoded 32-byte address where the data-map chunk will live.
    pub data_map_address: String,
}

/// Result of finalizing an externally-signed upload.
#[derive(uniffi::Record)]
pub struct FinalizeUploadResult {
    /// Number of chunks stored on the network.
    pub chunks_stored: u64,
}

/// Result of finalizing an externally-signed public data upload.
#[derive(uniffi::Record)]
pub struct PublicUploadResult {
    /// Hex-encoded 32-byte address where the data-map chunk was stored.
    pub address: String,
    /// Total number of chunks stored (content chunks + data-map chunk).
    pub chunks_stored: u64,
}

// ===== Error types =====

/// Error type for client operations.
#[derive(Debug, uniffi::Error, thiserror::Error)]
pub enum ClientError {
    #[error("Initialization failed: {reason}")]
    InitializationFailed { reason: String },
    #[error("Network error: {reason}")]
    NetworkError { reason: String },
    #[error("Payment error: {reason}")]
    PaymentError { reason: String },
    #[error("Invalid input: {reason}")]
    InvalidInput { reason: String },
    #[error("Not found: {reason}")]
    NotFound { reason: String },
    #[error("Already exists")]
    AlreadyExists,
    #[error("Wallet not configured")]
    WalletNotConfigured,
    #[error("Internal error: {reason}")]
    InternalError { reason: String },
}

impl ClientError {
    /// Numeric error code for programmatic handling across FFI.
    pub fn code(&self) -> i32 {
        match self {
            ClientError::InitializationFailed { .. } => 1,
            ClientError::NetworkError { .. } => 2,
            ClientError::PaymentError { .. } => 3,
            ClientError::InvalidInput { .. } => 4,
            ClientError::NotFound { .. } => 5,
            ClientError::AlreadyExists => 6,
            ClientError::WalletNotConfigured => 7,
            ClientError::InternalError { .. } => 8,
        }
    }
}

/// Map ant-core errors to FFI errors.
impl From<ant_core::data::Error> for ClientError {
    fn from(e: ant_core::data::Error) -> Self {
        use ant_core::data::Error;
        match e {
            Error::AlreadyStored => ClientError::AlreadyExists,
            Error::InvalidData(msg) => ClientError::InvalidInput { reason: msg },
            Error::Payment(msg) => ClientError::PaymentError { reason: msg },
            Error::Network(msg) => ClientError::NetworkError { reason: msg },
            Error::Timeout(msg) => ClientError::NetworkError { reason: format!("timeout: {msg}") },
            Error::InsufficientPeers(msg) => ClientError::NetworkError { reason: msg },
            other => ClientError::InternalError { reason: other.to_string() },
        }
    }
}

/// Error type for wallet operations.
#[derive(Debug, uniffi::Error, thiserror::Error)]
pub enum WalletError {
    #[error("Wallet creation failed: {reason}")]
    CreationFailed { reason: String },
    #[error("Operation failed: {reason}")]
    OperationFailed { reason: String },
}

impl WalletError {
    /// Numeric error code for programmatic handling across FFI.
    pub fn code(&self) -> i32 {
        match self {
            WalletError::CreationFailed { .. } => 1,
            WalletError::OperationFailed { .. } => 2,
        }
    }
}
