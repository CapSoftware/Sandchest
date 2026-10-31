const db = require('../lib/db')

function login () {
  return async (req, res) => {
    const user = await findUser(req.body.email)
    res.json(user)
  }
}

async function findUser (email) {
  return db.query("SELECT * FROM users WHERE email = '" + email + "'")
}

module.exports = { login }
