use thiserror::Error;

#[derive(Debug, Error)]
pub enum MeshError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("invalid {format} signature (expected {expected:#x}, got {got:#x})")]
    InvalidSignature { format: &'static str, expected: u32, got: u32 },

    #[error("unsupported {format} version {major}.{minor}")]
    UnsupportedVersion { format: &'static str, major: u16, minor: u16 },

    #[error("unsupported {format} field {field}: {value}")]
    InvalidField { format: &'static str, field: &'static str, value: String },

    // Reserved for upcoming SKL/ANM parsers — generic structural complaints
    // (e.g. "bone parent index out of range") that don't fit the typed
    // variants above. Suppress dead-code warning until those land.
    #[allow(dead_code)]
    #[error("{0}")]
    Malformed(String),
}

pub type Result<T> = std::result::Result<T, MeshError>;
