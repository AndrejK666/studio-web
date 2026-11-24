#!/usr/bin/env node
// The gate of ADR-0075: every pin of gears-rust and the Gearbox engine agrees
// with platform-release.toml -- the three images' engine ARGs, the desktop's
// archive hashes, product.gdl's gears-rust rev, the corpus the stand and Dev
// read, the toolkit in Cargo.toml and Cargo.lock, and the matcher's fixture.
// Exit 1 names each disagreement. `node scripts/platform-release.mjs --write`
// fixes the ones that are derived.

import { main } from "./platform-release.mjs";

process.exitCode = await main([]);
