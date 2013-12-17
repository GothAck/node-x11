#!/usr/bin/env node
require('colors');
var fs = require('fs')
  , path = require('path')
  , util = require('util')
  , repl = require('repl')
  , sax = require('sax')
  , program = require('commander')
  , XParser = require('./xparser')
  , indexer = require('./indexer')
  , oe = process.exit;

program
  .version(require('../package.json').version)
  // .option('-r, --repl', '')
  .option('-v, --verbose', 'Add verbose/debug logging')
  // .option('-j, --json [part]', '')
  .option('-c, --colour', 'Format output in colour');

if (program.verbose) {
  process.exit = function() {
      console.trace();
      oe(0);
  }
}

function readProto(index, protoname) {
  var x_parser = new XParser(sax.createStream(true, { trim: true }));
  if (program.verbose) {
    x_parser.on('openxcb', function (stack_pointer) {
      console.log('Open xcb', stack_pointer);
    })
    x_parser.on('closexcb', function (stack_pointer) {
      console.log('Close xcb', stack_pointer);
    })
  }
  fs.createReadStream(index[protoname].file).pipe(x_parser.xml_parser);
  return x_parser;
}

program
  .command('repl')
  .description('Start with REPL')
  .action(function () {
    var prompt = program.colour ? ('x_proto'.yellow.italic + ' (#) ' + '> '.cyan.bold) : 'x_proto (#) > '
      , status = ''
      , current = '';

    if (program.colour)
      ((function () {
        var _write = process.stdout.write;
        process.stdout.write =  function (data) {
          if (!_repl)
            return _write.call(this, data);
          var self = this;
          if (~ data.indexOf(current)) {
            console.log(_repl.bufferedCommand)
            var len = 13 + status.length + _repl.rli.line.length + 1;
            // data = '\x1B[24m' + data;
            // data += '\x1B[' + len + 'D';
            setTimeout(function () {
              _write.call(
                  self //\x1B[0F\x1B[0E
                , '\x1B[' + len + 'G');
            }, 0);
          }
          return _write.call(this, data);
        };
      })());

    var _repl = repl.start(current = prompt.replace('#', status));

    _repl.addStatus = function (s) {
      if (! ~ status.indexOf(s))
        status += s;
      _repl.prompt = current = prompt.replace('#', program.colour ? status.rainbow.bold : status);
    }
    _repl.delStatus = function (s) {
      status = status.replace(s, '');
      _repl.prompt = current = prompt.replace('#', program.colour ? status.rainbow.bold : status);
    }
    _repl.context._repl = _repl;
    _repl.context.proto = {};

    _repl.context.loadIndex = function () {
      indexer.index('./proto/', function (index) {
        _repl.addStatus('i');
        _repl.context.index = index;
        _repl.displayPrompt();
      });
    }
    _repl.context.loadIndex();

    _repl.context.readProto = function (part) {
      part = part || 'xproto';
      var x_proto = _repl.context.x_proto = readProto(_repl.context.index, part);
      x_proto.on('close_xcb', function () {
        _repl.addStatus('p');
        _repl.displayPrompt()
      });
    }
    _repl.commands['.rp'] = { 
        action: _repl.context.readProto
      , help: 'Run readProto()'
    };
  })
program
  .command('json [part]')
  .description('Output JSON document (Optionally part, defaults to xproto)')
  .option('-o, --output <filename>', 'Output to filename', path.normalize)
  .action(function (part, options) {
    part = part || 'xproto';
    indexer.index('./proto/', function (index) {
      var x_proto = readProto(index, part);
      x_proto.on('close_xcb', function () {
        if (!options.output || options.output == '-' )
          console.log(
            util.inspect(x_proto, { depth: null, colors: program.colour })
          );
        else
          fs.writeFileSync(
              options.output
            , util.inspect(x_proto, { depth: null, colors: program.colour }) + '\n'
            , 'utf8'
          );
        
        if (x_proto.unknown_tags.length) {
          var err = 'ERROR: There are unknown tags remaining'
          console.error(program.colour ? err.bold.red : err)
          console.error(util.inspect(
              x_proto.unknown_tags
            , { colors: program.colour }
          ));
        }
      })
    });
  })
program
  .on('generate.js', function () {
    console.log('RAR', arguments);
  })
program
  .parse(process.argv)

if (program.args.length === 1 && ('string' === typeof program.args[0]))
  program.help();

if (! program.args.length)
  program.help();