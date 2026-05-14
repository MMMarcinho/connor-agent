import type { TaskEntry, EpisodicEvent, AizoEntry, EmotionSnapshot } from '../types';

export class TaskStack {
  private tasks: TaskEntry[] = [];
  private maxDepth: number;
  private _nextId = 1;

  constructor(maxDepth = 8) {
    this.maxDepth = maxDepth;
  }

  push(description: string, parentId: string | null = null): string {
    if (this.tasks.length >= this.maxDepth) {
      const pausedIdx = this.tasks.findIndex(t => t.status === 'paused');
      if (pausedIdx >= 0) this.tasks.splice(pausedIdx, 1);
    }
    const task: TaskEntry = {
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

  active(): TaskEntry | null {
    for (let i = this.tasks.length - 1; i >= 0; i--) {
      if (this.tasks[i]!.status === 'active') return this.tasks[i]!;
    }
    return null;
  }

  complete(id: string): void {
    const task = this.tasks.find(t => t.id === id);
    if (task) task.status = 'completed';
    const prev = [...this.tasks].reverse().find(t => t.status === 'paused');
    if (prev) prev.status = 'active';
  }

  switchCount(): number {
    return this.tasks.filter(t => t.status === 'paused').length;
  }
}

export class EpisodicBuffer {
  private events: EpisodicEvent[] = [];
  private capacity: number;

  constructor(capacity = 50) {
    this.capacity = capacity;
  }

  push(event: Omit<EpisodicEvent, 'timestamp'>): void {
    if (this.events.length >= this.capacity) this.events.shift();
    this.events.push({ ...event, timestamp: Date.now() });
  }

  drainForReflection(): EpisodicEvent[] {
    return [...this.events];
  }

  get length(): number { return this.events.length; }
}

export class WorkingMemory {
  taskStack      = new TaskStack();
  activeContext  = '';
  episodicBuffer = new EpisodicBuffer();
  aizoRecallCache: AizoEntry[]       = [];
  emotionSnapshot: EmotionSnapshot | null = null;
}
