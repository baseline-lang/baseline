<script>
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>Page Not Found | Baseline</title>
	<meta name="description" content="The page you're looking for doesn't exist." />
</svelte:head>

<main id="main-content" class="pt-[var(--site-top)] pr-8 pb-20 pl-[var(--content-left)] flex items-center justify-center min-h-[60vh]">
	<div class="text-center">
		<h1 class="text-6xl font-bold mb-4">{page.status}</h1>
		<p class="text-[var(--fg-muted)] mb-8">{page.error?.message || 'Page not found'}</p>
		<a href="/" class="button button-primary">Back to home</a>
	</div>
</main>
