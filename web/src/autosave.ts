type State = 'saved' | 'dirty' | 'saving' | 'error';
const pending = new Set<{ flush: () => Promise<void> }>();

export const hasPendingSaves = () => pending.size > 0;
export const flushPendingSaves = async () => {
  await Promise.all([...pending].map((save) => save.flush()));
};

/** Sérialise les écritures et conserve les dernières frappes pendant un envoi. */
export class Autosave<T> {
  private revision = 0;
  private savedRevision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private value?: T;
  onState: (state: State, error?: string) => void = () => {};

  constructor(private readonly write: (value: T) => Promise<void>, private readonly delay = 600) {}

  update(value: T) {
    this.value = value;
    this.revision++;
    pending.add(this);
    this.onState('dirty');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, this.delay);
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.running) return this.running;
    if (this.revision === this.savedRevision) return Promise.resolve();
    this.running = this.drain().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async drain() {
    try {
      while (this.savedRevision !== this.revision) {
        const revision = this.revision;
        this.onState('saving');
        await this.write(this.value as T);
        this.savedRevision = revision;
      }
      pending.delete(this);
      this.onState('saved');
    } catch (error) {
      this.onState('error', (error as Error).message);
      throw error;
    }
  }
}
