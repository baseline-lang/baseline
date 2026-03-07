<script lang="ts">
	import { examples } from '$lib/data/examples';
</script>

<section id="examples" aria-labelledby="examples-heading">
	<h2 id="examples-heading">Examples</h2>
	<div class="flex flex-col gap-[var(--sp-4)]">
		{#each examples as example}
			<div class="grid grid-cols-2 gap-[var(--sp-5)] items-start">
				<div class="example-text">
					<h3>{example.title}</h3>
					<p>{@html example.description}</p>
				</div>
				<div class="example-code">
					<pre><code>{@html example.code}</code></pre>
				</div>
			</div>
		{/each}
	</div>
</section>
