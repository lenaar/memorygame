const server = require('kth-node-server')
const { safeGet } = require('safe-utils')
// Load .env file in development mode
const nodeEnv = process.env.NODE_ENV && process.env.NODE_ENV.toLowerCase()
if (nodeEnv === 'development' || nodeEnv === 'dev' || !nodeEnv) {
  require('dotenv').config()
}
// Now read the server config etc.
const config = require('./init/configuration').server
const AppRouter = require('kth-node-express-routing').Router
const appRoute = AppRouter()

// Expose the server and 
server.locals.secret = new Map()
module.exports = server
module.exports.getPaths = () => appRoute.getPaths()

/* ***********************
 * ******* LOGGING *******
 * ***********************
 */
const log = require('kth-node-log')
const packageFile = require('../package.json')

let logConfiguration = {
  name: packageFile.name,
  app: packageFile.name,
  env: process.env.NODE_ENV,
  level: config.logging.log.level,
  console: config.logging.console,
  stdout: config.logging.stdout,
  src: config.logging.src
}
log.init(logConfiguration)

/* **************************
 * ******* TEMPLATING *******
 * **************************
 */
const exphbs = require('express-handlebars')
const path = require('path')
server.set('views', path.join(__dirname, '/views'))
server.set('layouts', path.join(__dirname, '/views/layouts'))
server.set('partials', path.join(__dirname, '/views/partials'))
server.engine('handlebars', exphbs({
  defaultLayout: 'publicLayout',
  layoutsDir: server.settings.layouts,
  partialsDir: server.settings.partials,
}))
server.set('view engine', 'handlebars')
// Register handlebar helpers
require('./views/helpers')

/* ******************************
 * ******* ACCESS LOGGING *******
 * ******************************
 */
const accessLog = require('kth-node-access-log')
server.use(accessLog(config.logging.accessLog))

/* ****************************
 * ******* STATIC FILES *******
 * ****************************
 */
const browserConfig = require('./init/configuration').browser
const browserConfigHandler = require('kth-node-configuration').getHandler(browserConfig, appRoute.getPaths())
const express = require('express')

// helper
function setCustomCacheControl (res, path) {
  if (express.static.mime.lookup(path) === 'text/html') {
    // Custom Cache-Control for HTML files
    res.setHeader('Cache-Control', 'no-cache')
  }
}

// Files/statics routes--
// Map components HTML files as static content, but set custom cache control header, currently no-cache to force If-modified-since/Etag check.
server.use(config.proxyPrefixPath.uri + '/static/js/components', express.static('./dist/js/components', { setHeaders: setCustomCacheControl }))
// Expose browser configurations
server.use(config.proxyPrefixPath.uri + '/static/browserConfig', browserConfigHandler)
// Map static content like images, css and js.
server.use(config.proxyPrefixPath.uri + '/static', express.static('./dist'))
// Return 404 if static file isn't found so we don't go through the rest of the pipeline
server.use(config.proxyPrefixPath.uri + '/static', function (req, res, next) {
  var error = new Error('File not found: ' + req.originalUrl)
  error.statusCode = 404
  next(error)
})

// QUESTION: Should this really be set here?
// http://expressjs.com/en/api.html#app.set
server.set('case sensitive routing', true)


/* *******************************
 * ******* REQUEST PARSING *******
 * *******************************
 */
const bodyParser = require('body-parser')
const cookieParser = require('cookie-parser')
server.use(bodyParser.json())
server.use(bodyParser.urlencoded({ extended: true }))
server.use(cookieParser())

/* ***********************
 * ******* SESSION *******
 * ***********************
 */
const session = require('kth-node-session')
const options = config.session
options.sessionOptions.secret = config.sessionSecret
server.use(session(options))

/* ******************************
 * ******* AUTHENTICATION *******
 * ******************************
 */
const passport = require('passport')
const ldapClient = require('./adldapClient')
const { authLoginHandler, authCheckHandler, logoutHandler, pgtCallbackHandler, serverLogin, getServerGatewayLogin } = require('kth-node-passport-cas').routeHandlers({
  adminGroup: config.auth.adminGroup,
  casLoginUri: config.proxyPrefixPath.uri + '/login',
  casGatewayUri: config.proxyPrefixPath.uri + '/loginGateway',
  ldapConfig: config.ldap,
  ldapClient: ldapClient,
  server: server
})
require('./init/authentication')
server.use(passport.initialize())
server.use(passport.session())
appRoute.get('cas.login', config.proxyPrefixPath.uri + '/login', authLoginHandler)
appRoute.get('cas.gateway', config.proxyPrefixPath.uri + '/loginGateway', authCheckHandler)
appRoute.get('cas.logout', config.proxyPrefixPath.uri + '/logout', logoutHandler)
// Optional pgtCallback (use config.cas.pgtUrl?)
appRoute.get('cas.pgtCallback', config.proxyPrefixPath.uri + '/pgtCallback', pgtCallbackHandler)
// Convenience methods that should really be removed
server.login = serverLogin
server.gatewayLogin = getServerGatewayLogin

/* ******************************
 * ******* CORTINA BLOCKS *******
 * ******************************
 */
server.use(config.proxyPrefixPath.uri, require('kth-node-web-common/lib/web/cortina')({
  blockUrl: config.blockApi.blockUrl,
  proxyPrefixPath: config.proxyPrefixPath.uri,
  hostUrl: config.hostUrl,
  redisConfig: config.cache.cortinaBlock.redis
}))

/* ********************************
 * ******* CRAWLER REDIRECT *******
 * ********************************
 */
const excludePath = config.proxyPrefixPath.uri + '(?!/static).*'
const excludeExpression = new RegExp(excludePath)
server.use(excludeExpression, require('kth-node-web-common/lib/web/crawlerRedirect')({
  hostUrl: config.hostUrl,
}))

/* ************************
 * ******* LANGUAGE *******
 * ************************
 */
const { languageHandler } = require('kth-node-web-common/lib/language')
server.use(config.proxyPrefixPath.uri, languageHandler)

/* **********************************
 * ******* APPLICATION ROUTES *******
 * **********************************
 */
const { System, Sample } = require('./controllers')

// System routes
appRoute.get('system.monitor', config.proxyPrefixPath.uri + '/_monitor', System.monitor)
appRoute.get('system.about', config.proxyPrefixPath.uri + '/_about', System.about)
appRoute.get('system.paths', config.proxyPrefixPath.uri + '/_paths', System.paths)
appRoute.get('system.robots', '/robots.txt', System.robotsTxt)

// App routes
appRoute.get('system.index', config.proxyPrefixPath.uri + '/', serverLogin, Sample.getIndex)
appRoute.get('system.gateway', config.proxyPrefixPath.uri + '/gateway', getServerGatewayLogin('/'), Sample.getIndex)

// Mount app routes on server root
server.use('/', appRoute.getRouter())

/* ****************************
 * ******* SERVER START *******
 * ****************************
 */
server.start({
  useSsl: config.useSsl,
  pfx: config.ssl.pfx,
  passphrase: config.ssl.passphrase,
  key: config.ssl.key,
  ca: config.ssl.ca,
  cert: config.ssl.cert,
  port: config.port,
  logger: log
})