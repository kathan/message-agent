/*
message-agent test
*/
const Async = require('async');
const formidable = require('formidable');
const express = require('express');
const fs = require('fs');
const app = express();
const MessageAgent = require('../index.js');
const path = require('path');
const sendIt = require('@kathan/send-it');

const port = 8080;
const agent_1_name = 'test-agent1';
const agent_2_name = 'test-agent2';
const agent_1_url = `http://localhost:${port}/${agent_1_name}`;
const agent_2_url = `http://localhost:${port}/${agent_2_name}`;

app.set("json spaces", 2);
app.use((req, res, next)=>{
  if (req.method.toLowerCase() == 'post') {
    var form = new formidable.IncomingForm();
    form.parse(req, (err, fields, files) => {
      if(err){return;}
      req.body = fields;
      for(var i in files){
        files[i].data = fs.readFileSync(files[i].path);
      }
      req.files = files;
      next();
    });
    return;
  }
  next();
});

Async.series([
  (next)=>{
    app.listen(port, (err) => {
      if(err){console.error('Error opening port', port, err);return next(err);}
      console.log(`app listening on ${port}`);
      next();
    });
  },
  (next)=>{
    /*
    Create an agent that will pass files to a second agent.
    */
    var fa1 = MessageAgent(app,
                          {directory: path.resolve(__dirname, 'fa'),
                          name: agent_1_name,
                          url: agent_1_url,
                          dest: `http://localhost:${port}/${agent_2_name}`});
    
    fa1.on('ready', (err)=>{
      if(err){console.error('Error running', agent_1_name, err);return next(err);}
      console.log(`Running agent ${agent_1_name}`);
      //==== Start the first agent ====
      fa1.start();
      next();
    });
    
    fa1.on('payload', (payload, done)=>{
      //console.log('on payload', payload);
      if(payload.data.count){
        payload.data.count++;
      }else{
        payload.data.count = 0;
      }
      console.log('payload1', payload);
      done(true);
    });
    
    fa1.on('error', (err)=>{
      console.error('error 1', err);
    });
  },
  (next)=>{
    /*
    Create a second agent that passes received files back to the first agent.
    */
    var fa2 = MessageAgent(app, 
                          {directory: path.resolve(__dirname, 'fa'),
                          name: agent_2_name,
                          url: agent_2_url,
                          dest: `http://localhost:${port}/${agent_1_name}`});
    
    fa2.on('ready', (err)=>{
      if(err){console.error('Error running', agent_2_name, err);return next(err);}
      console.log(`Running agent ${agent_2_name}`);
      sendIt(agent_1_url, [path.resolve(__dirname, 'test.file')], {test:'data'}, (err, result, reply)=>{
      });
      //==== Start the second agent ====
      fa2.start();
      next();
    });
    
    fa2.on('payload', (payload, done)=>{
      var result = true;
  		//==== Stop after 5 round trips ====
      if(payload.data.count == 5){
        fa2.stop();
        result = false;
      }
      done(result);
    });
    
    fa2.on('error', (err)=>{
      console.error('error 2', err);
    });
  }],
  (err)=>{
    if(err){return console.error('Error', err);}
  }
);