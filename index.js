/*******************************************
* message-agent
* Copyright (c) 2018, Darrel Kathan 
* Licensed under the MIT license.
*
* A current version and documentation is available at
*    https://github.com/kathan/message-agent
*
* @summary     message-agent
* @description message-agent A Javascript module that for transferring messages over HTTP.
* @file        message-agent
* @version     0.0.1
* @author      Darrel Kathan
* @license     MIT
*******************************************/

const path = require('path');
const { spawn } = require('child_process');
const util = require('util');
const os = require('os');
const Url = require('url');
const crypto = require('crypto');
const EventEmitter = require('events').EventEmitter;

const fs = require('fs-extra');
const sendIt = require('@kathan/send-it');
const Async = require('async');

const FILE_DIR_NAME = 'files';

const MessageAgent = function(app, options, callback){
  if ( !(this instanceof MessageAgent) ){
    return new MessageAgent(app, options, callback);
  }
  var self = this;
  Object.assign(this,
    {
      get name() {
        return options.name;
      },
      get running() {
        return running;
      }
    }
  );
  var log = options.log || function(){
    var d = new Date();
    const args = Array.from(arguments);
    args.unshift(`"${name}"`);
    args.unshift(self.constructor.name);
    args.unshift(`${d}`);
    
    console.log.apply(this, args);
  };
  var error = options.error || function (){
    const args = Array.from(arguments);
    args.unshift('ERROR:');
    var e = new Error();
    args.push(e.stack);
    log.apply(null, args);
  };
  
  var hash;
  var running = false;
  //log('running', running);
  var name = options.name;//required
  //==== Getters ====
  
  var directory = path.resolve(options.directory, this.name);//required
  
  var in_dir = path.resolve(directory, 'in');
  var err_dir = path.resolve(directory, 'errors');
  var destination = null;

  var script = null;
  var mode = 'applescript';
  var ip = getIp();
  var port = options.port || 8080;
  var url = options.url || `http://${ip}:${port}`;
  var url_obj = Url.parse(url);
  
  
  EventEmitter.call(this);
  var immediate;
  function getIp(){
  	var intf = os.networkInterfaces();
  	for(var i in intf){
		var adds = intf[i];
		for(var a in adds){
			var add = adds[a];
			if(!add.internal && add.family === 'IPv4'){
				return add.address;
			}
		}
	}
  }
  
  log(`Upload payload at POST ${url_obj.pathname}.`);
  app.post(url_obj.pathname, (req, res, next) => {
    //==== Handle POST requests ====
    log(`${self.name} received data.`);
    //==== If there are files to process ====
    if(req.files){
      //==== Convert files from object to array ====
      var files = Object.values(req.files);
      
      //==== Sort files by name ====
      files.sort((a, b)=>{
        var nameA = a.name.toUpperCase(); // ignore upper and lowercase
        var nameB = b.name.toUpperCase(); // ignore upper and lowercase
        if (nameA < nameB) {
          return -1;
        }
        if (nameA > nameB) {
          return 1;
        }

        // names must be equal
        return 0;
      });
      
      //==== Store file and data ====
      storeData(files, req.body, (err, file_paths)=>{
        if(err){
          
          if(err.code && err.code === 'ENOTEMPTY' || err.code === 'EEXIST'){
            res.sendStatus(409);
            res.write(JSON.stringify({feedback:`This data already exists.`}));
          }else{
            error(`${err}`);
            res.sendStatus(500);
            res.write(JSON.stringify({feedback:`${err}`}));
          }
          res.end();
          return next();
        }else{
          res.json({feedback:`Payload was saved.`});
          //res.send();  
          next();
        }
      });
    }else{
      log('No file attached');
      res.sendStatus(400);
      res.end();
      next();
    }
  });
  
  log(`Get agent at ${url_obj.pathname}.`);
  app.get(url_obj.pathname, (req, res, next) => {
    //==== Handle GET requests ====
    log(`Received GET at ${url_obj.pathname}.`);
    self.getPayloads((err, payloads)=>{
      if(err){return res.status(500).send(err);}
      log(`Found payloads.`);
      res.json({agent: self.toJSON(), payloads:payloads});
      next();
    });
  });
  
  /* Update script */
  log(`Update agent at PUT ${url_obj.pathname}. Parameters [script, destination]`);
  app.put(url_obj.pathname, (req, res, next)=>{
    var messages = [];
    log(`Updating ${url_obj.pathname}`, req.body);
    Async.forEachOf(req.body,
      (value, key, done)=>{
        log(`Updating ${key}`, value);
        switch(key){
          case 'mode':
            self.setMode(req.body.mode);  
            messages.push(`Updated ${key}`);
            done();
            break;
          case 'script':
            self.setScript(req.body.script);  
            messages.push(`Updated ${key}`);
            done();
            break;
          case 'destination':
            self.setDest(req.body.destination);
            messages.push(`Updated ${key}`);
            done();
            break;
          default:
            done();
        }
      },
      (err)=>{
        if(err){
          next();
          return res.send(err);
        }
        res.send({feedback: messages});
        next();
      }
    );
  });
  
  log(`Start agent at PUT ${url_obj.pathname}/start.`);
  app.put(`${url_obj.pathname}/start`, (req, res, next)=>{
    res.json({feedback:[`Starting "${self.name}" agent.`]});
    self.start();
    next();
  });
  
  log(`Stop agent at PUT ${url_obj.pathname}/stop.`);
  app.put(`${url_obj.pathname}/stop`, (req, res, next)=>{
    res.json({feedback:[`Stopping "${self.name}" agent.`]});
    self.stop();
    next();
  });
  
  /*log(`Remove payload at DELETE ${url_obj.pathname}/[hash].`);
  app.delete(`${url_obj.pathname}`, (req, res, next)=>{
    res.json({feedback:[`Deleting "${self.name}".`]});
    self.stop();
    next();
  });*/
  
  this.setScript = function(scrpt){
    script = scrpt;
  };
  
  this.setMode = function(md){
    mode = md;
  };
  
  this.setDest = function(dst){
    return this.setDestination(dst);
  };
  
  this.setDestination = function(dst){
    log(`updating destination from ${destination} to ${dst}`);
    destination = dst;
  };
  
  this.stop = function(){
    if(running){
      log('Stopping', self.name);
      running = false;
      clearImmediate(immediate);
    }
  };
  
  this.start = function(){
    if(!running){
      log('Starting', self.name);
      running = true;
      process();
    }
  };
  
  this.getPayloads = function (cb){
    fs.readdir(in_dir, (err, payload_dirs)=>{
      if(err){error(err);return cb(err);}
      var result = [];
      Async.forEach(payload_dirs, (payload_dir, next)=>{
        fs.stat(path.resolve(in_dir, payload_dir),(err, stat)=>{
          if(err){return next(err);}
          if(stat.isDirectory()){
            getPayload(payload_dir,(err, obj)=>{
              if(err){return next(err);}
              if(obj){
                result.push(obj);
              }
              next();
            });
          }else{
            next();
          }
        });
      },(err)=>{
        if(err){return cb(err);}
        
        cb(null, result);
      });
    });
  };
  
  this.toJSON = function(){
    //log('calling', name, 'this.toJSON');
    return {
      name:self.name,
      url: Url.format(url),
      directory: directory,
      destination: destination,
      running:running,
      script: script,
      mode: mode
    };
  };
  
  //==== Private Functions ====
  
  function executeScript(payload, cb){
    var handler = require(`./lib/${mode}.js`);
    log('executing script');
    handler(script, payload, cb);
  }
  
  function processNextFile(cb){
    self.getPayloads((err, payloads)=>{
      if(err){cb(err);}
      if(payloads.length > 0){
        //=== Process the first file ====
        log('Processing payloads:', payloads[0]);
        //log('processNextFile payloads[0]', payloads[0]);
        handlePayload(payloads[0], (err)=>{
          if(err){return cb(err);}
          immediate = setImmediate(()=>{
            cb();
          });
        });
        return;
      }
      immediate = setImmediate(()=>{
        cb();
      });
    });
  }
  
  function process(){
    if(running){
      immediate = setImmediate(()=>{
        processNextFile(process);
      });
    }
  }
  
  function mv(source, dest, cb){
    fs.remove(dest,(err)=>{
      log('Moving', `"${source}"`, 'to', `"${dest}"`);
      var opts = ['-f', source, dest];
      const ls = spawn('mv', opts);
      var reply,error;
      var result = false;
      ls.stdout.on('data', (data) => {
        reply = data;
        //log('stdout:', $`{data}`);
      });
    
      ls.stderr.on('data', (data) => {
        error = data;
        //log('stderr:', `${data}`);
        //console.log(`stderr: ${data}`);
      });
    
      ls.on('close', (code) => {
        //log('mv result', 'code=', code, 'reply=', `${reply}`, 'error=', `${error}`);
        if(code === 0){
          result = true;
        }
        cb(error, reply, result);
      });
    });
  }
  
  function storeData(files, data, cb){
    var file_data = [];
    var new_paths = [];
    var tmp_dir = path.resolve(__dirname, '.tmp', self.name);
    //var tmp_dir = path.resolve(os.tmpdir(), 'fa', self.name);
    //==== Put file buffers into an array ====
    //log('files', files);
    //log('data', data);
    for(var i in files){
      file_data.push(fs.readFileSync(files[i].path));
    }
    //==== Create "hash" folder based on sha256 hash of file ====
    var file_hash = getHash(file_data, data);
    var temp_hash_dir = path.resolve(tmp_dir, file_hash);
    var dest_hash_dir = path.resolve(in_dir, file_hash);
    var temp_file_dir = path.resolve(temp_hash_dir, FILE_DIR_NAME);
    var dest_file_dir = path.resolve(dest_hash_dir, FILE_DIR_NAME);
    
    //==== Create new paths for each file ====
    for(i in files){
      files[i].new_path = path.resolve(temp_file_dir, files[i].name);
      //new_paths.push(path.resolve(dest_file_dir, files[i].name));
    }
    
    var data_file = path.resolve(temp_hash_dir, 'data.json');
    Async.series([
      (next)=>{
        //==== Create temp directory ====
        fs.ensureDir(temp_file_dir, (err)=>{
          if(err){return next(`mkdirp dest_file_dir: ${err}`);}
          next();
        });
      },
      
      (next)=>{
        //==== Serialize data to file called "data.json" within "hash" folder ====
        fs.writeFile(data_file, JSON.stringify(data), (err)=>{
          if(err){return next(`writeFile: ${err}`);}
          Async.forEach(files,
            (file, file_next)=>{
              //log('file', file);
              //==== Move file to "files" folder ====
              
              mv(file.path, file.new_path, (err)=>{
                if(err){return file_next(err);}
                //log(`Moved ${file.path}=>${file.new_path}`);
                file_next();
              });
            },
            (err)=>{
              if(err){return next(err);}
              mv(temp_hash_dir, dest_hash_dir, (err) => {
                if(err){return next(`${err} ${temp_hash_dir}=>${in_dir}`);}
                log('Stored', dest_hash_dir);
                next();
              });
            }
          );
        });
      }],
      (err)=>{
        if(err){
          error(`${err}`);
          cb(err);
        }
        cb(null, new_paths);
      }
    );
  }
  
  function getPayload(hash, cb){
    
    var file_obj = {hash: hash, files: [], data: ''};
    var payload_path = path.resolve(in_dir, hash);
    fs.readdir(payload_path, (err, files)=>{
      if(err){error(err);return cb(err);}
      //log('files', files);
      Async.forEach(files, (file, next_file)=>{
        var file_path = path.resolve(payload_path, file);
        //log('file_path', file_path);
        fs.stat(file_path, (err, stats)=>{
          if(err){return next_file(err);}
          if(file === 'data.json'){
            //var data_file_path = path.resolve(payload_path, file);
            
            fs.readFile(file_path, (err, data)=>{
              if(err){return next_file(err);}
              file_obj.data = JSON.parse(data.toString());
              
              next_file();
            });
          }else if(stats.isDirectory()){
            //==== Get the actual files from the files directory ====
            fs.readdir(path.resolve(in_dir, hash, file), (err, actual_files)=>{
              if(err){return next_file(err);}
              Async.forEach(actual_files, (actual_file, next_actual)=>{
                var actual_path = path.resolve(in_dir, hash, file, actual_file);
                stats.path = actual_path;
                stats.filename = path.basename(stats.path);
                file_obj.files.push(stats);
                next_actual();
              },(err)=>{
                if(err){return next_file(err);}
                next_file();
              });
            });
          }else{
            next_file();
          }
        });
      },(err)=>{
        if(err){error(err);return cb(err);}
        //log('file_obj', file_obj);
        cb(null, file_obj);
      });
      
    });
  }
  
  function getHash(file_buffers, data){
    hash = crypto.createHash('sha256');
    hash.update(JSON.stringify(data), 'utf8');
    for(var i in file_buffers){
      var file_buffer = file_buffers[i];
      //console.log('file_buffer', file_buffer);
      hash.update(file_buffer);
    }
    return hash.digest('hex');
  }
  
  function handlePayload(payload, cb){
    //var files = fs.readdirSync(path.resolve(hash_dir, 'file'));
    //console.log('handleFiles files', files);
    
    //==== Execute user script ====
    //log('payload', payload);
    executeScript(payload, (err, reply, result)=>{
      var payload_dir = path.resolve(in_dir, payload.hash);
      var dest_err_dir = path.resolve(err_dir, payload.hash);
      //==== Send file to next agent ====
      log('User script replied', result);
      if(result){
        if(!destination){
          var msg = 'No destination';
          log(msg);
          return cb(msg);
        }
        
        var start_time = Date.now();
        //log('payload', payload);
        var files = payload.files.map((file)=>{
          return file.path;
        });
        log('Sending', payload.files, 'to', destination);
        
        sendIt(destination, files, payload.data, (err, result, reply)=>{
          
          //log('Result is', result, 'for', files);
          if(err){error(`${err}`);}
          var end_time = Date.now();
          log(`agent.sendFile result`, result, (end_time-start_time), 'ms');
          //log(`${self.name} sendFile reply`, reply);
          if(result){
            log('Success sending', files, 'to', destination);
            //console.log('files', files);
            
            fs.remove(payload_dir, (err)=>{
              if(err){error(err);}
              //log(`Removed ${hash_dir}`);
              cb(true);
            });
          }else{
            //error(reply.statusCode);
            cb(false);
          }
        });
      }else{
        //==== Send to error folder ====
        
        mv(payload_dir, dest_err_dir, (err) => {
          if(err){error(`${err}`, payload_dir, dest_err_dir);}
          cb(false);
        });
      }
    });
  }
  options.destination ? this.setDestination(options.destination) : null;
  options.script ? this.setScript(options.script) : null;
  options.mode ? this.setMode(options.mode) : null;
  //log('options.running', options.running);
  //log('running before', running);
  if(options.running){
    this.start();
  }else{
    this.stop();
  }
  //log('running after', running);
  fs.ensureDir(in_dir, (err)=>{
    if(err){
      if(typeof callback === 'function'){
        callback(`mkdirp in_dir: ${err}`);
      }else{
        self.emit('error', err);
      }
      return;
    }
    
    //==== Create folder inside "in" folder called "errors" ====
    fs.ensureDir(err_dir, (err)=>{
      if(err && err.code !== 'EEXIST'){
        if(typeof callback === 'function'){
          callback(err);
        }else{
          self.emit('error', err);
        }
        return;
      }
      
      if(typeof callback === 'function'){
        setImmediate(callback);
      }else{
        setImmediate(()=>{
          self.emit('ready');
        });
      }
    });
  });
  
};

util.inherits(MessageAgent, EventEmitter);

module.exports = MessageAgent;