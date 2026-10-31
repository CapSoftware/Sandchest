function requireUser (req, res, next) {
  if (!req.session.user) return res.status(401).end()
  next()
}
module.exports = { requireUser }
