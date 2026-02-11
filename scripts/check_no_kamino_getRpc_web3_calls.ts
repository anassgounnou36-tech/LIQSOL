#!/usr/bin/env tsx
/**
 * Regression guard: Check for forbidden @solana/rpc usage and risky casts in Kamino integration
 * 
 * This script scans src/ for patterns that would cause "getAccountInfo is not a function" errors.
 * The Kamino SDK uses @solana/kit RPC which has a different shape than @solana/rpc.
 * 
 * Forbidden patterns:
 * - getRpc().getAccountInfo (legacy web3.js method calls)
 * - getRpc().getMultipleAccountsInfo
 * - getRpc().simulateTransaction
 * - getRpc().getLatestBlockhash
 * - from "@solana/rpc" (wrong import source)
 * - KaminoMarket.load(\s*rpc as any (risky type cast)
 * - KaminoObligation.load(\s*rpc as any (risky type cast)
 * 
 * Usage:
 *   npm run check:kamino:rpc
 *   npm run check:kamino:rpc:wsl (on Windows)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directories to exclude from scanning
const EXCLUDED_DIRS = ['node_modules', 'dist', '.git', 'data', 'test', '__tests__'];

// Forbidden patterns that indicate incorrect RPC usage
const FORBIDDEN_PATTERNS = [
  'getRpc().getAccountInfo',
  'getRpc().getMultipleAccountsInfo',
  'getRpc().simulateTransaction',
  'getRpc().getLatestBlockhash',
  'from "@solana/rpc"',
  'KaminoMarket\\.load\\(\\s*rpc as any',
  'KaminoObligation\\.load\\(\\s*rpc as any',
];

interface Violation {
  file: string;
  line: number;
  pattern: string;
  content: string;
}

/**
 * Recursively scan directory for TypeScript files
 */
function* walkTypeScriptFiles(dir: string): Generator<string> {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      // Skip excluded directories
      if (EXCLUDED_DIRS.includes(entry.name)) {
        continue;
      }
      yield* walkTypeScriptFiles(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      yield fullPath;
    }
  }
}

/**
 * Strip comments from a line of code
 * Handles single-line comments (//) and common comment markers
 * 
 * Note: This is a simple heuristic that handles most cases.
 * For more robust parsing, consider using a full TypeScript parser.
 */
function stripComments(line: string): string {
  const trimmed = line.trim();
  
  // Full line comments (most common case)
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('*/')) {
    return '';
  }
  
  // Check for block comment end marker anywhere in line
  if (trimmed.includes('*/')) {
    // If line is just closing block comment, skip it
    if (trimmed === '*/') {
      return '';
    }
    // Otherwise, this could be code after block comment close
    // For simplicity, we'll keep the line to avoid missing violations
  }
  
  // Inline comments (simple approach: strip everything after //)
  // This handles: const x = 1; // getRpc().getAccountInfo()
  const commentIndex = line.indexOf('//');
  if (commentIndex !== -1) {
    const codeBeforeComment = line.substring(0, commentIndex);
    return codeBeforeComment;
  }
  
  return line;
}

/**
 * Scan a file for forbidden patterns
 */
function scanFile(filePath: string): Violation[] {
  const violations: Violation[] = [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Strip comments before checking patterns
    const codeOnly = stripComments(line);
    if (!codeOnly) {
      continue; // Skip empty/comment-only lines
    }
    
    // Check each forbidden pattern
    for (const pattern of FORBIDDEN_PATTERNS) {
      // Check if pattern contains regex special characters
      const isRegex = pattern.includes('\\s') || pattern.includes('\\(');
      
      let match = false;
      if (isRegex) {
        // Use regex matching for patterns with special characters
        const regex = new RegExp(pattern);
        match = regex.test(codeOnly);
      } else {
        // Use simple string matching for literal patterns
        match = codeOnly.includes(pattern);
      }
      
      if (match) {
        violations.push({
          file: filePath,
          line: i + 1, // 1-indexed line numbers
          pattern,
          content: line.trim(),
        });
      }
    }
  }
  
  return violations;
}

/**
 * Main function
 */
function main(): void {
  console.log('🔍 Checking for forbidden kaminoMarket.getRpc() web3.js method calls...\n');
  
  const projectRoot = path.resolve(__dirname, '..');
  const srcDir = path.join(projectRoot, 'src');
  
  if (!fs.existsSync(srcDir)) {
    console.error(`❌ Error: src/ directory not found at ${srcDir}`);
    process.exit(1);
  }
  
  const allViolations: Violation[] = [];
  let filesScanned = 0;
  
  // Scan all TypeScript files in src/
  for (const filePath of walkTypeScriptFiles(srcDir)) {
    filesScanned++;
    const violations = scanFile(filePath);
    allViolations.push(...violations);
  }
  
  console.log(`📁 Scanned ${filesScanned} TypeScript files in src/\n`);
  
  if (allViolations.length === 0) {
    console.log('✅ No forbidden patterns found!\n');
    console.log('All Kamino SDK integrations use @solana/kit RPC correctly\n');
    process.exit(0);
  }
  
  // Report violations
  console.error(`❌ Found ${allViolations.length} violation(s):\n`);
  
  for (const violation of allViolations) {
    const relativePath = path.relative(projectRoot, violation.file);
    console.error(`  ${relativePath}:${violation.line}`);
    console.error(`    Pattern: ${violation.pattern}`);
    console.error(`    Line: ${violation.content}`);
    console.error('');
  }
  
  console.error('💡 Fix: Use @solana/kit for Kamino SDK RPC creation\n');
  console.error('Example:');
  console.error('  import { createSolanaRpc, address } from "@solana/kit";');
  console.error('  const rpc = createSolanaRpc(connection.rpcEndpoint);');
  console.error('  const market = await KaminoMarket.load(');
  console.error('    rpc,');
  console.error('    address(marketPubkey.toBase58()),');
  console.error('    1000,');
  console.error('    address(programId.toBase58())');
  console.error('  );');
  console.error('');
  
  process.exit(1);
}

main();
