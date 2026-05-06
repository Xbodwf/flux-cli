/**
 * Multi-Agent Workflow Example — Flux CLI
 *
 * Demonstrates how multiple agents (Architect → Coder → Reviewer)
 * collaborate through the Bridge to solve a task.
 *
 * Run: npx tsx examples/multi-agent-workflow.ts
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Agent {
  name: string;
  model: string;
  persona: string;
  temperature: number;
}

interface Artifact {
  agent: string;
  type: string;
  content: string;
}

// ─── Mock Agents ───────────────────────────────────────────────────────────────

const architect: Agent = {
  name: "architect",
  model: "claude-sonnet-4-20250505",
  persona: "Senior software architect — designs data models, APIs, and system plans",
  temperature: 0.2,
};

const coder: Agent = {
  name: "coder",
  model: "claude-haiku-3-5-20241022",
  persona: "Implementation engineer — writes clean, well-tested code",
  temperature: 0.3,
};

const reviewer: Agent = {
  name: "reviewer",
  model: "claude-sonnet-4-20250505",
  persona: "Senior code reviewer — catches bugs, suggests improvements, ensures best practices",
  temperature: 0.1,
};

// ─── Task ──────────────────────────────────────────────────────────────────────

const USER_TASK = "Create a function that validates and formats a phone number in E.164 format";
const LANGUAGE = "TypeScript";

// ─── Helper ────────────────────────────────────────────────────────────────────

function box(text: string) {
  const lines = text.split("\n");
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const top = `╔${"═".repeat(width)}╗`;
  const bottom = `╚${"═".repeat(width)}╝`;
  console.log(top);
  for (const line of lines) {
    console.log(`║  ${line.padEnd(width - 2)}║`);
  }
  console.log(bottom);
  console.log();
}

function separator(title: string) {
  console.log();
  console.log(`─${"─".repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`─${"─".repeat(70)}`);
  console.log();
}

// ─── Simulation ────────────────────────────────────────────────────────────────

console.log();
box("Flux Multi-Agent Workflow Simulation");
console.log(`Task: ${USER_TASK}`);
console.log(`Language: ${LANGUAGE}`);
console.log();

// ─── Step 1: Architect ─────────────────────────────────────────────────────────

separator("Step 1: Architect Analyzes & Designs");

console.log(`[${architect.name}] (${architect.model}) — thinking...`);
console.log();

const specs = `/**
 * PhoneNumber Validator (E.164 Format)
 *
 * Requirements:
 * 1. Accept US/CA phone numbers in various input formats:
 *    - (555) 123-4567
 *    - 555-123-4567
 *    - +1 555 123 4567
 *    - 15551234567
 *    - 5551234567
 * 2. Validate and convert to E.164: +15551234567
 * 3. Must have exactly 10 digits after country code
 *
 * Public API:
 *   formatPhoneNumber(input: string): { valid: boolean; e164?: string; error?: string }
 *
 * Edge cases to handle:
 *   - Empty string
 *   - Non-numeric characters (dashes, parens, spaces, dots)
 *   - Too few/many digits
 *   - Missing country code (assume +1)
 *   - Invalid country code
 */
`;

box(specs);

// ─── Bridge: Architect → Coder ─────────────────────────────────────────────────

separator("Bridge: Architect → Coder (direct message)");

console.log("Architect sends spec to Coder via Bridge...");
console.log();

// ─── Step 2: Coder ─────────────────────────────────────────────────────────────

separator("Step 2: Coder Implements");

console.log(`[${coder.name}] (${coder.model}) — implementing based on spec...`);
console.log();

const code = `/**
 * Formats a phone number to E.164 format.
 * @param input - Raw phone number string
 * @returns Object with validation result
 */
export function formatPhoneNumber(input: string): {
  valid: boolean;
  e164?: string;
  error?: string;
} {
  if (!input || input.trim().length === 0) {
    return { valid: false, error: "Input is empty" };
  }

  // Strip all non-digit characters except leading '+'
  const cleaned = input.replace(/[^\\d+]/g, "");

  // Extract digits
  let digits: string;
  let countryCode = "1"; // default to US/CA

  if (cleaned.startsWith("+")) {
    // Has explicit country code
    digits = cleaned.slice(1);
  } else {
    digits = cleaned;
  }

  // Handle 11-digit numbers starting with 1 (US country code included)
  if (digits.length === 11 && digits[0] === "1") {
    countryCode = "1";
    digits = digits.slice(1);
  }

  // Now we should have exactly 10 digits (NANP)
  if (digits.length !== 10) {
    return {
      valid: false,
      error: \`Expected 10 digits, got \${digits.length}\`,
    };
  }

  const e164 = \`+\${countryCode}\${digits}\`;

  return { valid: true, e164 };
}
`;

box(code);

// ─── Bridge: Coder → Reviewer ──────────────────────────────────────────────────

separator("Bridge: Coder → Reviewer (direct message)");

console.log("Coder sends implementation to Reviewer via Bridge...");
console.log();

// ─── Step 3: Reviewer ──────────────────────────────────────────────────────────

separator("Step 3: Reviewer Checks");

console.log(`[${reviewer.name}] (${reviewer.model}) — reviewing code...`);
console.log();

const review = `## Code Review Report

### ✅ Strengths
- Proper input validation (empty string check)
- Good use of regex for stripping non-digit characters
- Clear, descriptive function signature with JSDoc
- Handles multiple input formats gracefully
- E.164 output format is correct

### ⚠️ Suggestions
1. **Add area code validation** — NANP area codes cannot start with 0 or 1
2. **Consider international support** — Make country code detection pluggable
3. **Add unit tests** — Coverage for edge cases would be valuable
4. **TypeScript strictness** — Could use a branded type for E164 strings

### 🔍 Edge Cases Verified
- ✅ Empty string → returns error
- ✅ (555) 123-4567 → parses correctly
- ✅ 1-555-123-4567 → handles country code prefix
- ✅ +1 555 123 4567 → explicit country code
- ✅ Too few digits (6) → returns error
- ✅ Too many digits (15) → returns error

### ✅ Verdict: APPROVED (with suggestions)
`;

box(review);

// ─── Bridge: Reviewer → Architect (final) ──────────────────────────────────────

separator("Bridge: Reviewer → Architect (final report)");

console.log("Reviewer sends final review back to Architect via Bridge...");
console.log();

// ─── Summary ───────────────────────────────────────────────────────────────────

separator("Workflow Complete");

console.log("Summary of artifacts produced:");
console.log(`  📐 Architect: Design spec (${specs.length} chars)`);
console.log(`  💻 Coder:     Implementation (${code.length} chars)`);
console.log(`  🔍 Reviewer:  Review report (${review.length} chars)`);
console.log();
console.log("Agents used:");
console.log(`  • ${architect.name.padEnd(12)} → ${architect.model}`);
console.log(`  • ${coder.name.padEnd(12)} → ${coder.model}`);
console.log(`  • ${reviewer.name.padEnd(12)} → ${reviewer.model}`);
console.log();

box("✓ Task completed via multi-agent coordination");
