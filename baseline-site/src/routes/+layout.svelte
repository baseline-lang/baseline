<script>
	import "../app.css";
	import Nav from "$lib/components/Nav.svelte";

	let { children } = $props();
</script>

<div class="grid grid-cols-[var(--nav-width)_1fr] min-h-screen">
	<a href="#main-content" class="skip-link">Skip to content</a>
	<Nav />
	{@render children()}
</div>
