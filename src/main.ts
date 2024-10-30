import {
	debug,
	error,
	getInput,
	info,
	setFailed,
	setOutput
} from '@actions/core';
import { getOctokit } from '@actions/github';
import { HttpClient } from '@actions/http-client';
import { createWriteStream, mkdirSync } from 'fs';
import { promisify } from 'util';
import 'dotenv/config';
import stream from 'stream';

const pipeline = promisify(stream.pipeline);

// All the GitHub variables
const apiKey = getInput('apiKey');
const githubOrganization = getInput('githubOrganization', { required: true });
const githubRepository = getInput('githubRepository');
const repositoriesPerJob = getInput('repositoriesPerJob', { required: true });

// Initialise `octokit` with a custom privileged API key
const octokit = getOctokit(apiKey);

// Add sleep function to reduce calls to GitHub API when checking the status of the migration
async function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Main function for running the migration
async function run(org: string, githubRepository?: string): Promise<void> {
	let repoNames: string[][] = [];
	const backupFiles: string[] = [];
	let failures = 0;

	if (githubRepository && githubRepository !== '') {
		repoNames.push([githubRepository]);
	} else {
		repoNames = await getOrganisationRepositories(
			org,
			parseInt(repositoriesPerJob)
		);
	}

	// Create directory for backups
	const directory = `github_${githubOrganization}_${new Date()
		.toJSON()
		.replaceAll(':', '-')}`;
	mkdirSync(directory);
	debug(`Created directory "${directory}" for this backup run`);

	// Start backup processes (split with reposPerRun in each)
	const backups = repoNames.map((repositories, index) =>
		backup(org, repositories, directory, index)
	);

	// Wait for all backup runs to finish
	const results = await Promise.allSettled(backups);

	for (const result of results) {
		if (result.status === 'fulfilled') {
			backupFiles.push(result.value);
		} else {
			failures++;
			error(`Backup failed: ${result.reason}`);
		}
	}

	setOutput('backupFiles', backupFiles);
	setOutput('backupDirectory', directory);

	if (failures > 0) {
		setFailed(`${failures} backup jobs failed!`);
	} else {
		info('All backups completed!');
	}
}

async function getOrganisationRepositories(
	org: string,
	per_page: number
): Promise<string[][]> {
	let repoNames: string[][] = [];

	info('Get list of repositories...');

	let fetchMore = true;
	let page = 1;

	while (fetchMore) {
		const repos = await octokit.rest.repos.listForOrg({
			org,
			type: 'all',
			per_page,
			sort: 'full_name',
			page: page++
		});

		// At least one repo in the response
		if (repos.data.length > 0) {
			repoNames.push(repos.data.map(item => item.full_name));
		}

		fetchMore = repos.data.length >= per_page;
	}

	debug(JSON.stringify(repoNames, null, 2));

	return repoNames;
}

async function backup(
	org: string,
	repositories: string[],
	directory: string,
	index: number
): Promise<string> {
	const http = new HttpClient();
	const filename = `${directory}/github_${githubOrganization}_${index}_${new Date().toJSON()}.tar.gz`;
	let state = '';

	info(
		`#${index} - Starting backup for ${repositories.length} repositories...`
	);
	debug(
		`#${index} - Repositories: ${JSON.stringify(repositories, null, 2)}}`
	);

	// Start the migration on GitHub
	const {
		data: { id: migration_id }
	} = await octokit.rest.migrations.startForOrg({
		org,
		repositories,
		lock_repositories: false
	});

	info(`#${index} - Started successfully, migration id is ${migration_id}`);

	// Wait for status of migration to be exported
	do {
		await sleep(30000);

		const status = await octokit.rest.migrations.getStatusForOrg({
			org,
			migration_id
		});

		state = status.data.state;

		debug(`#${index} - State is ${state}...`);
	} while (state !== 'exported');

	info(
		`#${index} - Backup is ${state}, requesting download url of archive...`
	);

	// Fetches the URL to a migration archive
	const archive = await octokit.rest.migrations.downloadArchiveForOrg({
		org,
		migration_id
	});

	debug(archive.url);

	info(`#${index} - Downloading archive file to ${filename}...`);

	await downloadFile(archive.url, filename, index);

	// Deletes the migration archive. Migration archives are otherwise automatically deleted after seven days.
	info(`#${index} - Deleting organization migration archive from GitHub`);
	await octokit.rest.migrations.deleteArchiveForOrg({
		org,
		migration_id
	});

	info(`#${index} - ✅ Backup job done!`);

	return filename;
}

async function downloadFile(
	url: string,
	filename: string,
	index: number,
	retries: number = 3
): Promise<string> {
	const client = new HttpClient();

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const response = await client.get(url);

			// Check for successful response status
			if (response.message.statusCode !== 200) {
				throw new Error(
					`#${index} - Failed to download file: HTTP ${response.message.statusCode}`
				);
			}

			// Stream response to file
			const writeStream = createWriteStream(filename);
			await pipeline(response.message, writeStream);

			console.info(`#${index} - Download completed!`);
			return 'complete';
		} catch (error: any) {
			// Retry logic for socket hang-up errors
			if (error.code === 'ECONNRESET' && attempt < retries) {
				console.warn(
					`#${index} - Socket hang up, retrying... (${
						attempt + 1
					}/${retries})`
				);
				await new Promise(resolve =>
					setTimeout(resolve, 1000 * attempt)
				); // Exponential backoff
			} else {
				throw new Error(
					`#${index} - Failed after ${attempt + 1} attempts: ${
						error.message
					}`
				);
			}
		}
	}

	throw new Error(`#${index} - Exceeded maximum retries`);
}

// Start the backup script
run(githubOrganization, githubRepository);
