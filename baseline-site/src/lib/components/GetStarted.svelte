<section id="start" aria-labelledby="start-heading">
	<h2 id="start-heading">Install</h2>
	<div class="grid grid-cols-3 gap-[var(--sp-3)] mt-[var(--sp-4)]">

		<div class="install-card">
			<div class="step-header">
				<span class="step-number" aria-hidden="true">1</span>
				<h3>Install</h3>
			</div>
			<div class="step-content">
				<pre><code>brew install baseline-lang/tap/blc</code></pre>
			</div>
		</div>

		<div class="install-card">
			<div class="step-header">
				<span class="step-number" aria-hidden="true">2</span>
				<h3>Write</h3>
			</div>
			<div class="step-content">
				<p>Create <code>hello.bl</code>:</p>
				<pre><code>{@html `<span class="annot">@prelude</span><span class="punct">(</span><span class="fn">script</span><span class="punct">)</span>

<span class="kw">fn</span> <span class="fn">main!</span><span class="punct">()</span> <span class="op">-&gt;</span> <span class="effect">{Console}</span> <span class="punct">()</span> <span class="op">=</span>
  <span class="type">Console</span><span class="punct">.</span><span class="fn">print!</span><span class="punct">(</span><span class="str">"Hello, World!"</span><span class="punct">)</span>`}</code></pre>
			</div>
		</div>

		<div class="install-card">
			<div class="step-header">
				<span class="step-number" aria-hidden="true">3</span>
				<h3>Run</h3>
			</div>
			<div class="step-content">
				<pre><code>{@html `blc run hello.bl
<span class="comment"># Hello, World!</span>

blc check hello.bl --json
<span class="comment"># {"status": "ok", ...}</span>`}</code></pre>
			</div>
		</div>

	</div>
</section>
