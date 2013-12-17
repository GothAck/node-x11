#!/usr/bin/env node
require('colors');
var util = require('util')
  , path = require('path')
  , EventEmitter = require('events').EventEmitter
  , repl = require('repl')
  , sax = require('sax')
  , fs = require('fs')
  , assert = require('assert')
  , oe = process.exit
  , _ = require('underscore')
  , program = require('commander');

program
  .version(require('../package.json').version)
  // .option('-r, --repl', '')
  .option('-v, --verbose', 'Add verbose/debug logging')
  // .option('-j, --json [part]', '')
  .option('-c, --colour', 'Format output in colour');

if (process.verbose) {
  process.exit = function() {
      console.trace();
      oe(0);
  }
}

var keywords = {
    'class': 'windowClass'
};

function camelcase(name) {
  if (! name)
    return name;
  name = name.split('_').reduce(function(str, word){
    return str + word[0].toUpperCase() + word.slice(1);
  });
  var keyword = keywords[name];
  return keyword ? keyword : name;
}

function camelParam(a)
{
  return a[0].toLowerCase() + a.substr(1);
}

var baseTypeSize = {
   'enum': 1,
   'BOOL': 1,
   'UInt8': 1,
   'Int8': 1,
   'UInt16LE': 2,
   'Int16LE': 2,
   'UInt32LE': 4,
   'Int32LE': 4
}

var types = {
  'BOOL': 'UInt8',
  'BYTE': 'Int8',
  'CARD8': 'UInt8',
  'INT8': 'Int8',
  'CARD16': 'UInt16LE',
  'INT16': 'Int16LE',
  'CARD32': 'UInt32LE',
  'INT32': 'Int32LE'
}

function XParser (xml_parser) {
  this.type = null;
  this.types = _.clone(types);
  this.unknown_tags = [];
  var cursors = {
      elem: null
    , body: null
    , item: null
    , field: null
    , last_value: null
    , last_bit: null
    , in_doc: false
  }
  Object.defineProperties(
      this
    , {
          xml_parser: { enumerable: false, value: xml_parser }
        , cursors: { enumerable: false, value: cursors }
        , stack: { enumerable: false, value: [] }
        , opstack: { enumerable: false, value: [] }
        , _events: { enumerable: false, value: {} }
      }
  );
  this.objects = {};
  xml_parser.on('opentag', this.opentag.bind(this));
  xml_parser.on('closetag', this.closetag.bind(this));
  xml_parser.on('text', this.text.bind(this));
}
util.inherits(XParser, EventEmitter);
XParser.prototype.opentag = function (tag) {
  var curr_stack = [tag.name, {}, tag]
  this.stack.push(curr_stack);
  if (this.cursors.in_doc)
    return;
  try {
    switch (tag.name) {
      case 'xcb':
        this.type = tag.attributes.header;
        break;
      case 'xidtype':
        this.types[tag.attributes.name] = types.CARD32;
        break;
      case 'xidunion':
        curr_stack[1].xidunion_name = tag.attributes.name;
        curr_stack[1].xidunion = [];
        break;
      case 'typedef':
        this.types[tag.attributes.newname] = this.types[tag.attributes.oldname];
        break;
      case 'request':
      case 'struct':
      case 'event':
      case 'error':
      case 'enum':
        this.startStruct(tag.attributes.name, tag.name, tag);
        break;
      case 'reply':
        this.cursors.body = this.cursors.elem.reply = [];
        break;
      case 'eventcopy':
      case 'errorcopy':
        var type = tag.name.replace(/copy$/, '');
        this.startStruct(tag.attributes.name, type, tag);
        this.cursors.elem.ref = tag.attributes.ref;
        this.cursors.elem.body =
        this.cursors.body = this.objects[type][this.cursors.elem.ref].body;
        this.endStruct(type);
        break;
      case 'pad':
        this.cursors.body.push({ type: 'pad', bytes: parseInt(tag.attributes.bytes) });
        break;
      case 'item':
        if (this.cursors.item)
          console.error('Already an active item called', this.cursors.item.name);
        this.cursors.body.push(
          this.cursors.item = { name: tag.attributes.name }
        );
        break;
      case 'list':
        this.cursors.field = {
            name: camelcase(tag.attributes.name)
          , type: 'list'
          , list_of: tag.attributes.type
        };
        break;
      case 'valueparam':
         this.cursors.body.push({
             type: 'valueparam',
             maskRef: camelcase(tag.attributes['value-mask-name']),
             maskType: tag.attributes['value-mask-type'],
             listRef: tag.attributes['value-list-name']
         });
         break;
      case 'field':
      case 'exprfield':
        var f = {
            name: camelcase(tag.attributes.name)
          , type: tag.attributes.type
        };
        [
            'expression'
          , 'enum'
        ].forEach(function (fn) {
          if (this[fn])
            f[fn] = this[fn];
        }, tag.attributes);
        this.cursors.field = f;
        break;
      case 'op':
        this.opstack.push(tag.attributes.op);
        break;
      case 'fieldref':
      case 'value':
      case 'bit':
      case 'type':
        break;
      case 'doc':
      case 'union':
        this.cursors.in_doc = true;
        break;
      default:
        if (! ~this.unknown_tags.indexOf(tag.name)) {
          console.error('Unknown tag', tag.name, util.inspect(this.stack, { depth: 3 }));
          this.unknown_tags.push(tag.name);
        }
    }
    this.emit('open_' + tag.name, curr_stack);
  } catch (e) {
    console.error(e, this.stack, curr_stack);
  }
}
XParser.prototype.closetag = function (tag) {
  var prev_stack = this.stack.pop()
    , stack_pointer = this.stack_pointer;
  if (tag === 'doc' || tag === 'union')
    return this.cursors.in_doc = false;
  if (this.cursors.in_doc)
    return;
  try {
    switch (tag) {
      case 'xidunion':
        if (! (prev_stack[1].xidunion_name && prev_stack[1].xidunion))
          throw new Error('xidunion wonky, ' + prev_stack[1].xidunion_name + '|' + prev_stack[1].xidunion);
        this.types[prev_stack[1].xidunion_name] = prev_stack[1].xidunion;
        break;
      case 'request':
      case 'struct':
      case 'event':
      case 'error':
      case 'enum':
        this.endStruct(tag);
        break;
      case 'reply':
        this.cursors.body = this.cursors.elem.body;
        break;
      case 'item':
        if (this.cursors.last_value !== null)
          this.cursors.item.value = this.cursors.last_value;
        if (this.cursors.last_bit !== null)
          this.cursors.item.bit_mask = this.cursors.last_bit;
        this.cursors.item = this.cursors.last_value = this.cursors.last_bit = null;
        break;
      case 'list':
        this.cursors.field.length = this.cursors.field.expr || this.cursors.last_value;
        this.cursors.last_value = null;
        delete this.cursors.field.expr;
      case 'field':
      case 'exprfield':
        this.cursors.body.push(this.cursors.field);
        this.cursors.field = null;
        break; //TODO: Figure out why this was missing, what does it break being here?!
      case 'op':
        if (this.cursors.field)
          this.cursors.field.expr = '(' + prev_stack[1].values.join(' ' + this.opstack.pop() + ' ') + ')'
      case 'fieldref':
        if (prev_stack[1].text)
          prev_stack[1].text = '[' + camelcase(prev_stack[1].text) + ']';
      case 'value':
        var value = prev_stack[1].text;
        if (/^\d+$/.test(value))
          this.cursors.last_value = parseInt(value)
        else
          this.cursors.last_value = value;
        if (! stack_pointer[1].values)
          stack_pointer[1].values = [];
        stack_pointer[1].values.push(this.cursors.last_value);
        break;
      case 'bit':
        this.cursors.last_bit = 1<<parseInt(prev_stack[1].text);
        break;
      case 'type':
        if (stack_pointer[1].xidunion_name)
          stack_pointer[1].xidunion.push(prev_stack[1].text);
        break;
      case 'xcb':
        if (! this.unknown_tags && this.unknown_tags.length)
          delete this.unknown_tags;
        break;
      default:
    }
    this.emit('close_' + tag, prev_stack);
  } catch (e) {
    console.error(e);
    console.error(e.stack);
    console.error(prev_stack);
  }
}
XParser.prototype.__defineGetter__('stack_pointer', function () {
  return this.stack.slice(-1)[0];
});
XParser.prototype.text = function (text) {
  var sp_object = this.stack_pointer[1];
  sp_object.text = (sp_object.text || '') + text;
}
XParser.prototype.startStruct = function (name, type, tag) {
  if (this.cursors.elem)
    console.error('Struct already open :/', name, type, this.stack);
  if (! name)
    console.error('Struct of type', type, 'started with no name!');
  if (this.objects[name]) {
    console.error('Struct with this name already exists', name, type);
    console.error(this.objects[name]);
    console.error('OVERWRITING!');
  }
  this.cursors.elem = {
      name: name
    , type: type
    , body: (this.cursors.body = [])
  };
  if (type === 'request') {
    var op = this.cursors.elem.opcode = parseInt(
      tag.attributes.opcode
    );
    assert.strictEqual(op.toString(), tag.attributes.opcode);
  }
  return this.cursors.elem;
}
XParser.prototype.endStruct = function (type) {
  if (type !== this.cursors.elem.type)
    console.error(
        'ending struct type', type
      ,'does not match active_elem type', this.cursors.elem.type
    );
  if (! this.objects[type])
    this.objects[type] = {};
  this.objects[type][this.cursors.elem.name] = this.cursors.elem;
  this.cursors.elem = 
    this.cursors.body =
    this.cursors.item = null;
}
XParser.prototype.startEnum = function (name, _, tag) {

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

var makeindex = require('./makeindex');

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
    // Object.defineProperty(_repl.rli, '_promptLength', { value: 14 });
    // console.log(_repl.rli)
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
      makeindex('./proto/', function (index) {
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
    makeindex('./proto/', function (index) {
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