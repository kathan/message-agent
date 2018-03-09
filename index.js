/*******************************************
* send-it
* Copyright (c) 2018, Darrel Kathan 
* Licensed under the MIT license.
*
* A current version and some documentation is available at
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
const util = require('util');
const fs = require('fs');
const os = require('os');
const Url = require('url');
const crypto = require('crypto');
const EventEmitter = require('events').EventEmitter;

const sendIt = require('@kathan/send-it');
const Async = require('async');
const rimraf = require('rimraf');
const mkdirp = require('mkdirp');

const FILE_DIR_NAME = 'files';

const MessageAgent = function(app, options, callback){
  if ( !(this instanceof MessageAgent) ){
    return new MessageAgent(app, options, callback);
  }
  
  var self = this;
  var hash;
  var running = options.running || false;
  
  //var name = options.name;//required
  //==== Getters ====
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
  var directory = options.directory;//required
  var in_dir = path.resolve(directory, 'in');
  var err_dir = path.resolve(directory, 'errors');
  var dest;
  options.dest ? dest = options.dest : null;
  var script;
  options.script ? script = self.setScript(options.script) : null;
  var url = options.url;
  var url_obj = Url.parse(url);
  var log = options.log || function(){
    var d = new Date();
    const args = Array.from(arguments);
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
  
  EventEmitter.call(this);
  var immediate;
  
  //log(`Creating agent ${name}`);
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
          
          if(err.code && err.code === 'ENOTEMPTY'){
            res.status(409);
            res.write(`This data already exists.`);
          }else{
            res.status(500);
            error(err);
          }
          res.end();
          return next();
        }
        
        res.send();  
        next();
      });
    }else{
      res.status(400);
      res.end();
      next();
    }
  });
  
  app.get(url_obj.pathname, (req, res, next) => {
    //==== Handle GET requests ====
    self.getPayloads((err, payloads)=>{
      res.json({agent: self.toJSON(), payloads:payloads});
      next();
    });
  });
  
  /* Update script */
  app.put(`${url_obj.pathname}`, (req, res, next)=>{
    Async.forEachOf(
      (value, key, done)=>{
        switch(key){
          case 'script':
            self.setScript(req.body.script, (err)=>{
              done(err);
            });
            break;
        }
      },
      (err)=>{
        next();
      }
    );
  });
  
  app.put(`${url_obj.pathname}/start`, (req, res, next)=>{
    res.json({message:`Starting ${self.name} request`});
    self.start();
    next();
  });
  
  app.put(`${url_obj.pathname}/stop`, (req, res, next)=>{
    res.json({message:`Stopping ${self.name} request`});
    self.stop();
    next();
  });

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
    fs.readdir(in_dir, (err, hash_dirs)=>{
      //if(err){error(err);return cb(err);}
      var result = [];
      Async.forEach(hash_dirs, (hash_dir, next)=>{
        fs.stat(path.resolve(in_dir, hash_dir),(err, stat)=>{
          //if(hash_dir !== '.DS_Store'){
          if(stat.isDirectory()){
            getPayload(hash_dir,(err, obj)=>{
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
        cb(null, result);
      });
    });
  };
  
  this.toJSON = function(){
    return {
      name:self.name,
      url: url,
      directory: directory,
      running:running
    };
  };
  
  //==== Private Functions ====
  
  function processNextFile(cb){
    self.getPayloads((err, files, data)=>{
      if(files.length > 0 || data){
        //=== Process the first file ====
        log(self.name, 'Processing files:', files[0], 'data:', data);
        handleFiles(files[0].files, data, (err)=>{
          if(err){return cb(err);}
          cb();
        });
        return;
      }
      cb();
    });
  }
  
  function process(){
    if(running){
      immediate = setImmediate(()=>{
        processNextFile(process);
      });
    }
  }
  
  function storeData(files, data, cb){
    var file_data = [];
    var new_paths = [];
    var tmp_dir = path.resolve(os.tmpdir(), 'fa', self.name);
    //==== Put file buffers into an array ====
    for(var i in files){
      file_data.push(files[i].data);
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
      new_paths.push(path.resolve(dest_file_dir, files[i].name));
    }
    
    var data_file = path.resolve(temp_hash_dir, 'data.json');
    mkdirp(in_dir, (err)=>{
      if(err){self.emit('error', err);return cb(`mkdirp in_dir: ${err}`);}
      //==== Create folder inside "hash" folder called "file" ====
      mkdirp(temp_file_dir, (err)=>{
        if(err){self.emit('error', err);return cb(`mkdirp temp_file_dir: ${err}`);}
        
        //==== Serialize data to file called "data.json" within "hash" folder ====
        fs.writeFile(data_file, JSON.stringify(data), (err)=>{
          if(err){self.emit('error', err);return cb(`writeFile: ${err}`);}
          Async.forEach(files,
            (file, next)=>{
              
              //==== Move file to "files" folder ====
              fs.rename(file.path, file.new_path , (err)=>{
                if(err){self.emit('error', err);return next(err);}
                
                next();
              });
            },
            (err)=>{
              if(err){return cb(err);}
              fs.rename(temp_hash_dir, dest_hash_dir, (err) => {
                if(err){return cb(err);}
                log(self.name, 'Stored', dest_hash_dir);
                cb(null, new_paths);
              });
            }
          );
        });
      });
    });
  }
  
  function getPayload(hash_dir, cb){
    
    var file_obj = {hash: hash_dir, files: []};
    fs.readdir(path.resolve(in_dir, hash_dir), (err, files)=>{
      if(err){error(err);return cb(err);}
      //log('files', files);
      Async.forEach(files, (file, next_file)=>{
        if(file === 'data.json'){
          fs.readFile(path.resolve(in_dir, hash_dir, file), (err, data)=>{
            file_obj.data = JSON.parse(data);
            next_file();
          });
        }else{
          //==== Get the actual files from the files directory ====
          fs.readdir(path.resolve(in_dir, hash_dir, file), (err, actual_files)=>{
            Async.forEach(actual_files, (actual_file, next_actual)=>{
              var actual_path = path.resolve(in_dir, hash_dir, file, actual_file);
              //file_obj.files.push(actual_path);
              fs.stat(actual_path, (err, stats)=>{
                stats.path = actual_path;
                file_obj.files.push(stats);
                next_actual();
              });
            },()=>{
              next_file();
            });
          });
        }
      },(err)=>{
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
  
  function handleFiles(files, data, cb){
    //var files = fs.readdirSync(path.resolve(hash_dir, 'file'));
    //console.log('handleFiles files', files);
    var hash_dir;
    var hash;
    //==== Execute user script ====
    self.emit('file', files, data, (result)=>{
      hash_dir = path.resolve(path.dirname(files[0].path), '..');
      hash = path.basename(hash_dir);
      var dest_err_dir = path.resolve(err_dir, hash);
      //==== Send file to next agent ====
      log(self.name, 'User script replied', result);
      if(result){
        if(!dest){
          var msg = 'No destination';
          log(self.name, msg);
          return cb(msg);
        }
        
        var start_time = Date.now();
        log(self.name, 'Sending', files, 'to', dest);
        sendIt(dest, files, data, (err, result, reply)=>{
          log(self.name, 'Result is', result, 'for', files);
          if(err){error(err);}
          var end_time = Date.now();
          log(self.name, `agent.sendFile result`, result, (end_time-start_time), 'ms');
          //log(`${self.name} sendFile reply`, reply);
          if(result){
            log(self.name, 'Success sending', files, 'to', dest);
            //console.log('files', files);
            
            rimraf(hash_dir, (err)=>{
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
        
        fs.rename(hash_dir, dest_err_dir, (err) => {
          error(err);
          cb(err);
        });
      }
    });
  }
  
  if(typeof callback === 'function'){
    setImmediate(callback);
  }else{
    self.emit('ready');
  }
};

util.inherits(MessageAgent, EventEmitter);

module.exports = MessageAgent;