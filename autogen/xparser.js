#!/usr/bin/env node
var util = require('util')
  , EventEmitter = require('events').EventEmitter
  , assert = require('assert')
  , _ = require('underscore');

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

module.exports = XParser;