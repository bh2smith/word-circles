//! Dumps the OpenAPI spec to stdout as pretty JSON.
//!
//! Used to refresh the committed snapshot consumed by the frontend's
//! TypeScript client generation (`make openapi`). Builds the spec in memory,
//! so it needs no database or network.

use utoipa::OpenApi;
use word_circles_backend::ApiDoc;

fn main() {
    let spec = ApiDoc::openapi()
        .to_pretty_json()
        .expect("failed to serialize OpenAPI spec");
    println!("{spec}");
}
