'use strict';

// Usage: npm run hash -- path/to/file.zip
// Prints the fileName, size and sha256 to paste into manifest.json.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('Usage: npm run hash -- path/to/file.zip');
  process.exit(1);
}

const hash = crypto.createHash('sha256');
fs.createReadStream(file)
  .on('data', (chunk) => hash.update(chunk))
  .on('end', () => {
    console.log(
      JSON.stringify({ fileName: path.basename(file), size: fs.statSync(file).size, sha256: hash.digest('hex') }, null, 2)
    );
  });
