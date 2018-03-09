# file-agent
A lightweight library written in node.js to automate hot folders.
```js
/*
file-agent test
*/
const Async = require('async');
const formidable = require('formidable');
const express = require('express');
const fs = require('fs');
const app = express();
const FileAgent = require('../index.js');
const path = require('path');

const port = 4536;
const agent_1_name = 'test-agent1';
const agent_2_name = 'test-agent2';

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
    app.listen(port, () => {
      console.log(`app listening on ${port}`);
      next();
    });
  },
  (next)=>{
    /*
    Create an agent that will pass files to a second agent.
    */
    var fa1 = FileAgent(app, path.resolve(__dirname, 'fa'), agent_1_name, `http://localhost:${port}/${agent_2_name}`);
    
    fa1.on('ready', (err)=>{
      if(err){return next(err);}
      console.log(`Running agent ${agent_1_name}`);
      //==== Start the first agent ====
      fa1.start();
      next();
    });
    
    fa1.on('file', (file, payload, done)=>{
      payload.count++;
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
    var fa2 = FileAgent(app, path.resolve(__dirname, 'fa'), agent_2_name);
    
    fa2.emit('ready', `http://localhost:${port}/${agent_1_name}`, (err)=>{
      if(err){return next(err);}
      console.log(`Running agent ${agent_2_name}`);
      //==== Start the second agent ====
      fa2.start();
      next();
    });
    
    fa2.on('file', (file, payload, done)=>{
      var result = true;
  		//==== Stop after 5 round trips ====
      if(payload.count == 5){
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
```