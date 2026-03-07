<section class="hero pt-0 mt-0 mb-[var(--sp-6)]" aria-labelledby="hero-heading">
    <h1 id="hero-heading" class="hero wordmark">Baseline</h1>
    <div class="grid grid-cols-2 gap-[var(--sp-5)] items-start mt-[var(--sp-3)]">
        <div class="min-w-0">
            <p class="text-[1.4rem] text-[var(--fg-muted)] mt-0 mb-[var(--sp-4)] max-w-[32em]">
                A fast, safe functional language that is easy to learn but hard
                to break, whether you're writing the code yourself or with an AI
                agent.
            </p>
            <ul class="flex flex-col gap-3 list-none p-0 mb-0" role="list">
                <li class="pl-[1.2em] relative before:content-['•'] before:absolute before:left-0 before:text-[var(--fg-dim)]">
                    <em class="block not-italic font-semibold text-[var(--fg)] text-base mb-0.5">Simple to learn</em>
                    <span class="text-base leading-[1.618] text-[var(--fg-muted)]">Small, consistent syntax that reads the same everywhere</span>
                </li>
                <li class="pl-[1.2em] relative before:content-['•'] before:absolute before:left-0 before:text-[var(--fg-dim)]">
                    <em class="block not-italic font-semibold text-[var(--fg)] text-base mb-0.5">Fast and lightweight</em>
                    <span class="text-base leading-[1.618] text-[var(--fg-muted)]">Compiled to native code with low memory usage</span>
                </li>
                <li class="pl-[1.2em] relative before:content-['•'] before:absolute before:left-0 before:text-[var(--fg-dim)]">
                    <em class="block not-italic font-semibold text-[var(--fg)] text-base mb-0.5">Safe by default</em>
                    <span class="text-base leading-[1.618] text-[var(--fg-muted)]">The compiler checks types, effects, and error handling before your code runs</span>
                </li>
            </ul>
        </div>
        <div class="min-w-0 flex flex-col">
            <pre class="text-[1.1rem] leading-[1.6] pt-[5px]"
                aria-label="Baseline code example: fetching a user with error handling"><code
                    >{@html `<span class="kw">fn</span> <span class="fn">fetch_user!</span><span class="punct">(</span><span class="fn">id</span><span class="op">:</span> <span class="type">Int</span><span class="punct">)</span> <span class="op">-&gt;</span> <span class="type">Result&lt;String, String&gt;</span> <span class="op">=</span>
  <span class="type">Console</span><span class="punct">.</span><span class="fn">print!</span><span class="punct">(</span><span class="str">"Fetching user \${id}"</span><span class="punct">)</span>
  <span class="kw">let</span> <span class="fn">response</span> <span class="op">=</span> <span class="type">Http</span><span class="punct">.</span><span class="fn">get!</span><span class="punct">(</span><span class="str">"/users/\${id}"</span><span class="punct">)</span><span class="op">?</span>
  <span class="kw">match</span> <span class="fn">response</span><span class="punct">.</span><span class="fn">status</span>
    <span class="num">200</span> <span class="op">-&gt;</span> <span class="type">Ok</span><span class="punct">(</span><span class="fn">response</span><span class="punct">.</span><span class="fn">body</span><span class="punct">)</span>
    <span class="num">404</span> <span class="op">-&gt;</span> <span class="type">Err</span><span class="punct">(</span><span class="str">"User not found"</span><span class="punct">)</span>
    <span class="fn">code</span> <span class="op">-&gt;</span> <span class="type">Err</span><span class="punct">(</span><span class="str">"HTTP \${code}"</span><span class="punct">)</span>`}</code
                ></pre>
            <div class="flex gap-3 flex-wrap mt-auto">
                <a href="#start" class="button button-primary">Install</a>
                <a
                    href="https://github.com/baseline-lang/baseline"
                    class="button"
                    aria-label="View on GitHub (external site)"
                    >View on GitHub</a
                >
            </div>
        </div>
    </div>
</section>
