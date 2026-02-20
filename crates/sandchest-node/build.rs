fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::configure()
        .build_server(true)
        .build_client(false)
        .compile_protos(
            &["sandchest/node/v1/node.proto"],
            &["../../packages/contract/proto"],
        )?;
    Ok(())
}
