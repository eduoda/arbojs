let {mysql,emitter,vars,permissions,mailer,cron} = require('./globals')
let express = require("express");
let cors = require('cors')
// let {MySQL} = require('./mysql');
let {Var} = require('./modules/var');
let {Permission,Role,RolePermission,PermissionCache} = require('./modules/permission');
let {User,Token} = require('./modules/user');
let {Section,Membership,MembershipRole} = require('./modules/section');
let {Content,ContentSection,Page} = require('./modules/content');

let arbo = ({_mysqlOptions,_mailOptions}) => {
  _mysqlOptions = Object.assign({}, {
    connectionLimit: 10,
    host: "localhost",
    database: "arbo",
    user: "root",
    password: "root"
  }, _mysqlOptions);
  mysql.setOptions(_mysqlOptions)
  if(!_mailOptions)
    _mailOptions = {test:true};
  mailer.setOptions(_mailOptions);
  cron.mysql = mysql;

  app = express();
  app.use(cors());
  app.use(express.json({limit: '100mb'}));
  app.use(mysql.mw());
  app.use(async (req, res, next) => {
    res.locals.requesterIp = (req.headers['x-forwarded-for']
      ? req.headers['x-forwarded-for'].split(',').pop().trim()
      : req.connection
        ? req.connection.remoteAddress
        : req.socket
          ? req.socket.remoteAddress
          : req.connection.socket
            ? req.connection.socket.remoteAddress
            : '')?.replace(/::ffff:/g, '') || 'unknown IP' ;

    // console.log(`incoming request: ${req.url}`);
    if(['POST','PUT','DELETE','PATCH'].includes(req.method)){
      // console.log('START TRANSACTION;')
      await User.rawAll(res.locals.conn,'START TRANSACTION;');
    }
    res.locals.conn.arbo = {
      req: req,
      res: res,
      next: next,
    }
    return next();
  });
  app.modules = [
    Var,Permission,Role,RolePermission,
    User,Token,Section,Membership,MembershipRole,
    PermissionCache,Content,ContentSection,Page
  ];

  app.addModule = async function(mod){
    app.modules.push(mod);
  }

  app.enableModule = async function(conn,mod){
    try{
      if(!vars['module_'+mod.name]){
        console.log("Installing "+mod.name);
        // new module
        if(mod.name!='Permission'){
          if(mod.permissions)
            for(const perm of mod.permissions)
              await new Permission({permission:perm}).save(conn)
          await Permission.loadPermissions(conn)/* .then(console.log("Permissions reloaded")) */;
        }
        if(mod.setup)
          await mod.setup(conn);
        else if(mod.createTable)
          await mod.createTable(conn);
        await new Var({name:'module_'+mod.name,value:true}).save(conn);
        await Var.loadVars(conn)/* .then(console.log("Vars reloaded")) */;
        console.log("Installed "+mod.name);
      }
      if(mod.load)
        await mod.load(conn);
    }catch(e){
      console.error("Error installing module "+mod.name);
      console.log(e)
      return;
    }
  }

  app.serve = async function(port){
    try{
      let conn = await mysql.getConn();

      await User.rawRun(conn,'SET FOREIGN_KEY_CHECKS = 0;', []);
      for(mod of app.modules){
        if(mod.shouldUninstall){
          console.log("Uninstalling "+mod.name);
          if(mod.uninstall) await mod.uninstall(conn);
          else await mod.dropTable(conn)
          if(mod.name!='Permission'){
            if(mod.permissions)
              for(const perm of mod.permissions){
                try{
                  let p = await new Permission({permission:perm}).first(conn);
                  await p.delete(conn);
                }catch(e){
                  console.error("Error uninstalling module "+mod.name);
                  console.log(e);
                  return;
                }
              }
            await Permission.loadPermissions(conn)/* .then(console.log("Permissions reloaded")) */;
          }
          let modvar = new Var({name:'module_'+mod.name});
          await modvar.first(conn);
          await modvar.delete(conn);
          console.log("Uninstalled "+mod.name);
        }
      }
      await User.rawRun(conn,'SET FOREIGN_KEY_CHECKS = 1;', []);

      let tables = await User.rawAll(conn,'SELECT table_name AS t FROM information_schema.tables WHERE table_schema=?;',[_mysqlOptions.database]).then(res => res.map(x => x.t))

      if(tables.includes("var")){
        // load infos
        await Var.loadVars(conn)/* .then(console.log("Vars loaded")) */;
      }else {
        // empty db, new installation
        await Var.setup(conn);
        await new Var({name:'module_'+Var.name,value:true}).save(conn);
        await Var.loadVars(conn)/* .then(console.log("Vars loaded")) */;
      }

      if(tables.includes("permission")){
        await Permission.loadPermissions(conn)/* .then(console.log("Permissions loaded")) */;
      }

      for(let i = 0;i<app.modules.length; i++){
        let mod = app.modules[i];
        await app.enableModule(conn,mod);
      }

      for(let i = 0;i<app.modules.length; i++){
        let mod = app.modules[i];
        if(mod.addMiddleware){
          mod.addMiddleware(app);
        }
      }

      for(let i = 0;i<app.modules.length; i++){
        let mod = app.modules[i];
        if(mod.router){
          // console.log("Add "+mod.name+" route at "+mod.basePath)
          app.use(mod.basePath,mod.router);
        }
      }

      app.use('/*', async (req, res, next) => {
        if (!res.writableEnded) {
          const msg = (req.url.includes('.') || req.url == '/')
            ? 'suspicious request'
            : `${req.url} is not a valid route`;

          next({code: 404, msg, requesterIp: res.locals.requesterIp});
        }
        else next();
      })

      conn.release();
    }catch(e){
      console.log(e);
    }
    app.use(async (req, res, next) => {
      // console.log(`request to ${req.url} exited with status ${res.statusCode}`);
      if(['POST','PUT','DELETE','PATCH'].includes(req.method)){
        // console.log("COMMIT");
        await User.rawAll(res.locals.conn,'COMMIT;');
      }
      res.locals.conn.arbo = null;
      await res.locals.conn.release();
      next();
    });
    app.use(async (err, req, res, next) => {
      if (req.url.includes('.') || req.url == '/') console.log(`suspicious request from ${res.locals.requesterIp}`);
      else {
        console.log(`error on request from ${res.locals.requesterIp} to ${req.url}:`);
        console.log(err);  
      }      
      if(['POST','PUT','DELETE','PATCH'].includes(req.method)){
        // console.log("ROLLBACK");
        await User.rawAll(res.locals.conn,'ROLLBACK;');
      }
      res.locals.conn.arbo = null;
      await res.locals.conn.release();
      if(res.headersSent){
        console.error("ERROR AFTER HEADERS");
        console.error(err);
        return next(err);
      }
      if(err.code=='ER_DUP_ENTRY') err = 409;
      else if (err.code && err.msg?.endsWith('is not a valid route')) err = 404;
      else if (err.code && err.msg == 'suspicious request') {
        err = 404;
        // TODO: write this to fail2ban log file
      }
      if(Number.isInteger(err)) res.status(err).send();
      else {
        console.error(err);
        res.status(500).send();
      }
      next(err);
    });
    port = port?port:3000;
    app.server = app.listen(port, () => {console.log("Arbo running on port "+port)});
  }
  return app;
}

if(process.argv[2]==='run'){
  let api = arbo({_mysqlOptions:{}});
  api.serve();
}

module.exports = arbo;
