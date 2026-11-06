<script lang="ts">
  // Range input that shows its value live but only commits on release, so a drag doesn't
  // re-run k-means or tracing on every pixel of movement.
  let {
    label,
    value = $bindable(),
    min,
    max,
    step = 1,
    fmt = (v: number) => String(v),
    hint = '',
  }: { label: string; value: number; min: number; max: number; step?: number; fmt?: (v: number) => string; hint?: string } = $props();

  let live = $state(value);
  $effect(() => {
    live = value;
  });
</script>

<label class="slider" title={hint}>
  <span class="row"><span>{label}</span><output>{fmt(live)}</output></span>
  <input type="range" {min} {max} {step} value={live} oninput={(e) => (live = +e.currentTarget.value)} onchange={(e) => (value = +e.currentTarget.value)} />
</label>

<style>
  .slider {
    display: grid;
    gap: 4px;
  }
  .row {
    display: flex;
    justify-content: space-between;
    font-size: 0.9rem;
  }
  output {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  input {
    width: 100%;
    accent-color: var(--accent);
  }
</style>
