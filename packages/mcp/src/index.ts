#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Sandchest } from '@sandchest/sdk'
import { createServer } from './server.js'

const sandchest = new Sandchest()
const server = createServer(sandchest)
const transport = new StdioServerTransport()

await server.connect(transport)
