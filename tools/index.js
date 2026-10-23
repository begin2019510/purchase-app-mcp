'use strict';
const registerPurchase = require('./purchase');
const registerExpense = require('./expense');
const registerTodo = require('./todo');
const registerProject = require('./project');
const registerBudget = require('./budget');
const registerDocs = require('./docs');
const registerAnalytics = require('./analytics');

// ctx = { api, log }
module.exports = function registerAllTools(server, ctx) {
  registerPurchase(server, ctx);
  registerExpense(server, ctx);
  registerTodo(server, ctx);
  registerProject(server, ctx);
  registerBudget(server, ctx);
  registerDocs(server, ctx);
  registerAnalytics(server, ctx);
};
