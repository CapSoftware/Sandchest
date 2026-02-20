fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Node proto — server stubs for Node service, client stubs for Control service
    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        .compile_protos(
            &["sandchest/node/v1/node.proto"],
            &["../../packages/contract/proto"],
        )?;

    // Agent proto — client stubs (we connect to guest agents)
    tonic_build::configure()
        .build_server(false)
        .build_client(true)
        .compile_protos(
            &["sandchest/agent/v1/agent.proto"],
            &["../../packages/contract/proto"],
        )?;

    Ok(())
}
