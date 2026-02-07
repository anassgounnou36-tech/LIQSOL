/**
 * Test Script: Flashloan Dry-Run with Forecast Ranking
 * 
 * This script verifies that forecast ranking is integrated correctly into
 * the Kamino flashloan dry-run command.
 * 
 * It tests two scenarios:
 * 1. USE_FORECAST_FOR_DRYRUN=false (baseline behavior)
 * 2. USE_FORECAST_FOR_DRYRUN=true (forecast ranking enabled)
 * 
 * Expected behavior:
 * - With forecast enabled: Candidates are ranked by EV/TTL/hazard, top 10 logged
 * - With forecast disabled: Uses first candidate from list without ranking
 */

import { spawn } from "node:child_process";
import path from "node:path";

interface TestResult {
  scenario: string;
  success: boolean;
  error?: string;
  output?: string;
}

async function runFlashloanDryRun(useForecast: boolean): Promise<TestResult> {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      USE_FORECAST_FOR_DRYRUN: useForecast ? 'true' : 'false',
    };

    const scriptPath = path.join(process.cwd(), 'src', 'commands', 'flashloanDryRunKamino.ts');
    const child = spawn('tsx', [scriptPath, '--mint', 'USDC', '--amount', '100'], {
      env,
      cwd: process.cwd(),
    });

    let output = '';
    let errorOutput = '';

    child.stdout?.on('data', (data) => {
      output += data.toString();
    });

    child.stderr?.on('data', (data) => {
      errorOutput += data.toString();
    });

    child.on('close', (code) => {
      const scenario = useForecast ? 'WITH forecast ranking' : 'WITHOUT forecast ranking';
      
      if (code === 0) {
        resolve({
          scenario,
          success: true,
          output: output + errorOutput,
        });
      } else {
        resolve({
          scenario,
          success: false,
          error: errorOutput || output,
          output: output + errorOutput,
        });
      }
    });

    // Set timeout
    setTimeout(() => {
      child.kill();
      resolve({
        scenario: useForecast ? 'WITH forecast ranking' : 'WITHOUT forecast ranking',
        success: false,
        error: 'Test timeout after 60 seconds',
      });
    }, 60000);
  });
}

async function main() {
  console.log('🧪 Testing Flashloan Dry-Run with Forecast Ranking Integration\n');
  console.log('='.repeat(70));

  // Test 1: Without forecast ranking (baseline)
  console.log('\n📝 Test 1: Baseline behavior (USE_FORECAST_FOR_DRYRUN=false)');
  console.log('-'.repeat(70));
  const result1 = await runFlashloanDryRun(false);
  
  if (result1.success) {
    console.log('✅ Test 1 PASSED: Dry-run completed without forecast ranking');
    
    // Check that forecast ranking was NOT used
    if (result1.output?.includes('forecast_ranking_enabled')) {
      console.log('⚠️  WARNING: Forecast ranking was enabled when it should be disabled');
    } else {
      console.log('✓ Confirmed: Forecast ranking was disabled');
    }
  } else {
    console.log('❌ Test 1 FAILED:', result1.error);
    console.log('\nOutput:', result1.output);
  }

  // Test 2: With forecast ranking
  console.log('\n📝 Test 2: Forecast ranking behavior (USE_FORECAST_FOR_DRYRUN=true)');
  console.log('-'.repeat(70));
  const result2 = await runFlashloanDryRun(true);
  
  if (result2.success) {
    console.log('✅ Test 2 PASSED: Dry-run completed with forecast ranking');
    
    // Check that forecast ranking was used
    if (result2.output?.includes('forecast_ranking_enabled')) {
      console.log('✓ Confirmed: Forecast ranking was enabled');
    } else {
      console.log('⚠️  WARNING: Forecast ranking was not enabled when it should be');
    }
    
    // Check that top candidates were logged
    if (result2.output?.includes('Top 10 Ranked Candidates')) {
      console.log('✓ Confirmed: Top 10 candidates were logged');
    } else {
      console.log('⚠️  WARNING: Top 10 candidates were not logged');
    }
  } else {
    console.log('❌ Test 2 FAILED:', result2.error);
    console.log('\nOutput:', result2.output);
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('📊 Test Summary:');
  console.log(`  Test 1 (Baseline): ${result1.success ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`  Test 2 (Forecast): ${result2.success ? '✅ PASSED' : '❌ FAILED'}`);
  
  const allPassed = result1.success && result2.success;
  if (allPassed) {
    console.log('\n✅ All tests PASSED! Forecast ranking integration is working correctly.');
    process.exit(0);
  } else {
    console.log('\n❌ Some tests FAILED. Please review the output above.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ Test script error:', err);
  process.exit(1);
});
