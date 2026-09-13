// Focus-neutral staging for the manual tester. The transport supplies PNG hashes
// and persists every observation before it can authorize an action.
export class DesktopWorkflow {
  reference;

  constructor(send, wait, inputEnabled) {
    this.send = send;
    this.wait = wait;
    this.inputEnabled = inputEnabled;
  }

  async run(command, signal) {
    const { delaySeconds = 3, ...fields } = command;
    if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 30)
      throw new Error('delaySeconds must be an integer from 1 to 30.');
    if (!['observe', 'action'].includes(fields.kind)) throw new Error('Use observe, action, or stop.');
    if (fields.kind === 'action' && (!this.inputEnabled || !this.reference))
      throw new Error('Capture and review an image with input enabled before staging an action.');
    // Callers cannot override transport IDs or substitute a previously actionable image.
    for (const field of ['version', 'requestId', 'generation', 'observationId'])
      if (field in fields) throw new Error(`${field} is managed by the driver.`);

    const capture = fields.kind === 'observe' ? fields : this.reference.capture;
    const reviewed = this.reference?.frame;
    this.reference = undefined;
    try {
      await this.wait(delaySeconds * 1000, signal);
      signal.throwIfAborted();
      if (this.inputEnabled) await this.send({ kind: 'start' });
      signal.throwIfAborted();
      const frame = await this.send(capture);
      signal.throwIfAborted();
      this.reference = { capture, frame };
      if (fields.kind === 'observe') return;
      if (!frame.actionable || !sameEvidence(reviewed, frame))
        throw new Error('Image, window, or geometry changed. Review the new PNG and explicitly submit a new action. No input was sent.');

      // Consume the reviewed image even if transport fails. Never automatically retry.
      this.reference = undefined;
      await this.send({ ...fields, observationId: frame.observationId });
      signal.throwIfAborted();
      // Post-action capture has its own receipt; failure cannot erase dispatch evidence.
      const after = await this.send(capture);
      signal.throwIfAborted();
      this.reference = { capture, frame: after };
    } finally {
      if (signal.aborted) this.reference = undefined;
      await this.send({ kind: 'stop' });
    }
  }
}

function sameEvidence(left, right) {
  const identity = frame => ({
    digest: frame.digest, windowRef: frame.windowRef, foregroundWindowRef: frame.foregroundWindowRef,
    bounds: frame.bounds, crop: frame.crop, width: frame.width, height: frame.height, dpi: frame.dpi,
    windows: [...frame.windows].sort((a, b) => a.windowRef.localeCompare(b.windowRef)),
  });
  return !!left?.digest && !!right?.digest && JSON.stringify(identity(left)) === JSON.stringify(identity(right));
}
