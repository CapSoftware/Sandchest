fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::configure()
        .build_server(true)
        .build_client(false)
        .compile_protos(
            &["sandchest/agent/v1/agent.proto"],
            &["../../packages/contract/proto"],
        )?;
    Ok(())
}
