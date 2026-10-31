const { exec } = require('child_process')
exec('rm -rf ' + process.argv[2])
