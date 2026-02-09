import { UsageCandidate, MappingEntry } from "../src/types.js";
import { findModelMapping } from "../src/candidates.js";
import { assert } from "console";

function testShadowing() {
    const candidate: UsageCandidate = {
        provider: "anthropic",
        displayName: "Claude",
        windowLabel: "Sonnet",
        usedPercent: 50,
        remainingPercent: 50,
        account: "work"
    };

    const mappings: MappingEntry[] = [
        {
            usage: { provider: "anthropic", window: "Sonnet" }, // Generic (no account)
            model: { provider: "anthropic", id: "claude-3-5-sonnet-global" }
        },
        {
            usage: { provider: "anthropic", account: "work", window: "Sonnet" }, // Specific
            model: { provider: "anthropic", id: "claude-3-5-sonnet-work" }
        }
    ];

    const mapping = findModelMapping(candidate, mappings);
    console.log(`Found mapping: ${mapping?.model?.id}`);
    
    if (mapping?.model?.id !== "claude-3-5-sonnet-work") {
        console.error("FAIL: Generic mapping shadowed specific mapping");
        process.exit(1);
    } else {
        console.log("PASS: Specific mapping preferred");
    }
}

testShadowing();
