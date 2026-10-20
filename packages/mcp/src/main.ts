#!/usr/bin/env node
import { existsSync } from "node:fs";
import { configureHubMachine, localPaths, scoutRoot } from "@scout/ops";
import { McpServer } from "./server.ts";
import { createTools } from "./tools.ts";

const INSTRUCTIONS = "Scout watches the services and listeners on one person's computers. The read tools show what runs where and what is down. scout_start_service starts a stopped service. Stop and restart are only planned here (scout_plan_action); a person confirms them on the Scout page, in the tray panel, or on the CLI. scout_competitors and scout_competitor_queue read the competitor watch. scout_competitor_claim, scout_competitor_complete, and scout_competitor_fail change a research run's state and do not touch files, repositories, or machines.";

const root = scoutRoot();
if (existsSync(`${root}/machines.json`)) configureHubMachine(`${root}/machines.json`);
const dbIndex = process.argv.indexOf("--db");
const paths = localPaths(root, dbIndex >= 0 ? process.argv[dbIndex + 1] : undefined);
const server = new McpServer({ name: "scout", version: "0.2.0", instructions: INSTRUCTIONS }, createTools({ paths }));
await server.serve(process.stdin, process.stdout);
