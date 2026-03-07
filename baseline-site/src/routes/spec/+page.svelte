<script lang="ts">
    let { data } = $props();
</script>

<svelte:head>
    <title>Language Specification | Baseline</title>
    <meta
        name="description"
        content="The Baseline language specification: types, effects, modules, testing, and more."
    />
</svelte:head>

<main id="main-content" class="pt-[var(--site-top)] pr-8 pb-20 pl-[var(--content-left)]">
    <div class="grid grid-cols-[1fr_14rem] gap-[var(--content-left)] items-start">
        <article class="interior-content spec-content max-w-[48em] min-w-0">
            <h1 class="interior-h1 mb-5">Language Specification</h1>
            {@html data.html}
        </article>

        <aside class="toc-sidebar sticky top-[var(--site-top)] max-h-[calc(100vh-3.25rem)] overflow-y-auto pb-8" aria-label="Table of contents">
            <h2 class="toc-title mb-3">On this page</h2>
            <nav>
                <ul role="list">
                    {#each data.toc as entry}
                        <li class="toc-{entry.level}">
                            <a href="#{entry.id}">{entry.text}</a>
                        </li>
                    {/each}
                </ul>
            </nav>
        </aside>
    </div>
</main>
