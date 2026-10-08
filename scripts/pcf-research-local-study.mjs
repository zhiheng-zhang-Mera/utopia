import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {runLocalStudy} from '../services/personal-compute-fabric/research-study.mjs';
const [configPath,outputDirectory]=process.argv.slice(2);
if(!configPath||!outputDirectory){console.error('Usage: node scripts/pcf-research-local-study.mjs <frozen-config.json> <output-directory>');process.exitCode=2;}
else{
 try{const report=await runLocalStudy(JSON.parse(await readFile(resolve(configPath),'utf8')),{directory:resolve(outputDirectory)});console.log(JSON.stringify(report,null,2));if(report.infrastructureFailures.length||report.summary.failed||!report.trace.replayValidated||report.trace.droppedRecords||report.trace.retentionTruncated||report.trace.adapter.dropped||report.trace.failures.length)process.exitCode=1;}
 catch(error){console.error(JSON.stringify({state:'FAILED',code:error.code??'STUDY_FAILED',message:error.message,recoveryLedger:error.report??null}));process.exitCode=1;}
}
