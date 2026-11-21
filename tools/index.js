'use strict';
const registerPurchase = require('./purchase');
const registerExpense = require('./expense');
const registerTodo = require('./todo');
const registerProject = require('./project');
const registerBudget = require('./budget');
const registerDocs = require('./docs');
const registerAnalytics = require('./analytics');
const registerTracker = require('./tracker');
const registerTime = require('./time');

// ctx = { api, log }
module.exports = function registerAllTools(server, ctx) {
  registerPurchase(server, ctx);
  registerExpense(server, ctx);
  registerTodo(server, ctx);
  registerProject(server, ctx);
  registerTracker(server, ctx);
  registerBudget(server, ctx);
  registerDocs(server, ctx);
  registerAnalytics(server, ctx);
  registerTime(server, ctx);
};
