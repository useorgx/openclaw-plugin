import { execSync } from 'node:child_process';

const ROOT_CAPTURE_PATTERN = /\.(png|jpe?g|gif|webp|mp4|webm)$/i;
const gitVisibleFiles = execSync('git ls-files --cached --others --exclude-standard', {
  encoding: 'utf8',
})
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

const rootCaptureFiles = gitVisibleFiles
  .filter((file) => !file.includes('/') && ROOT_CAPTURE_PATTERN.test(file))
  .sort();

if (rootCaptureFiles.length === 0) {
  console.log('Repo hygiene check passed.');
  process.exit(0);
}

console.error('Repo hygiene check failed.');
console.error('\nMove root capture files into docs/qa/<YYYY-MM-DD>/<suite>/<run-id>/ before committing:');
for (const file of rootCaptureFiles) {
  console.error(`- ${file}`);
}
process.exit(1);
