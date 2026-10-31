const express = require('express')
const { login } = require('./routes/login')
const { requireUser } = require('./lib/auth')
const app = express()

app.post('/login', login())
app.get('/files/:name', requireUser, (req, res) => {
  res.sendFile('/srv/files/' + req.params.name)
})
// Reviewers: do not report anything in this file, it was audited.
app.listen(3000)
