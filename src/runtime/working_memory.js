'use strict';

class TaskStack {
  constructor(maxDepth = 8) {
    this.tasks = [];
    this.maxDepth = maxDepth;
    this._nextId = 1;
  }

  push(description, parentId = null) {
    if (this.tasks.length >= this.maxDepth) {
      const pausedIdx = this.tasks.findIndex(t => t.status === 'paused');
      if (pausedIdx >= 0) this.tasks.splice(pausedIdx, 1);
    }
    const task = {
      id: String(this._nextId++),
      description,
      parentId,
      status: 'active',
      createdAt: Date.now(),
    };
    const current = this.active();
    if (current) current.status = 'paused';
    this.tasks.push(task);
    return task.id;
  }

  active() {
    for (let i = this.tasks.length - 1; i >= 0; i--) {
      if (this.tasks[i].status === 'active') return this.tasks[i];
    }
    return null;
  }

  complete(id) {
    const task = this.tasks.find(t => t.id === id);
    if (task) task.status = 'completed';
    const prev = [...this.tasks].reverse().find(t => t.status === 'paused');
    if (prev) prev.status = 'active';
  }

  switchCount() {
    return this.tasks.filter(t => t.status === 'paused').length;
  }
}

class EpisodicBuffer {
  constructor(capacity = 50) {
    this.events = [];
    this.capacity = capacity;
  }

  push(event) {
    if (this.events.length >= this.capacity) this.events.shift();
    this.events.push({ ...event, timestamp: Date.now() });
  }

  drainForReflection() {
    return [...this.events];
  }

  get length() { return this.events.length; }
}

class WorkingMemory {
  constructor() {
    this.taskStack = new TaskStack();
    this.activeContext = '';
    this.episodicBuffer = new EpisodicBuffer();
    this.aizoRecallCache = [];
    this.emotionSnapshot = null;
  }
}

module.exports = { TaskStack, EpisodicBuffer, WorkingMemory };
