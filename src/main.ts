import { debug, error, getInput, info, setOutput } from '@actions/core';
import { getOctokit } from '@actions/github';
import { HttpClient } from '@actions/http-client';
import * as fs from 'fs';
import 'dotenv/config';

// All the GitHub variables
const apiKey = getInput('apiKey');
const githubOrganization = getInput('githubOrganization');
const githubRepository = getInput('githubRepository');
const octokit = getOctokit(apiKey);

// Add sleep function to reduce calls to GitHub API when checking the status of the migration
async function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Main function for running the migration
async function run(
	organization: string,
	githubRepository?: string
): Promise<void> {
	const reposPerRun = 50;
	let repoNames: Array<string[]> = [];

	if (githubRepository && githubRepository !== '') {
		repoNames.push([githubRepository]);
	} else {
		info('Get list of repositories...');

		let fetchMore = true;
		let page = 1;

		while (fetchMore) {
			const repos = await octokit.rest.repos.listForOrg({
				org: organization,
				type: 'all',
				per_page: reposPerRun,
				sort: 'full_name',
				page: page++
			});
			repoNames.push(repos.data.map(item => item.full_name));

			fetchMore = repos.data.length >= reposPerRun;
		}
	}

	debug(JSON.stringify(repoNames, null, 2));

	// Create directory for backups
	const directory = `github_${githubOrganization}_${new Date()
		.toJSON()
		.replaceAll(':', '-')}`;
	fs.mkdirSync(directory);
	debug(`Created directory "${directory}" for this backup run`);

	// Start backup processes (split with reposPerRun in each)
	const backups = repoNames.map((repositories, index) =>
		backup(organization, repositories, directory, index)
	);

	// Wait for all backup runs to finish
	const results = await Promise.allSettled(backups);

	const backupFiles: string[] = [];

	for (const result of results) {
		if (result.status === 'fulfilled') {
			backupFiles.push(result.value);
		} else {
			error('Backup failed');
		}
	}

	info('All backups completed!');

	setOutput('backupFiles', backupFiles);
	setOutput('backupDirectory', directory);
}

async function backup(
	org: string,
	repositories: string[],
	directory: string,
	index: number
): Promise<string> {
	const http = new HttpClient();

	info(
		`#${index} - Starting backup for ${repositories.length} repositories...`
	);
	debug(
		`#${index} - Repositories: ${JSON.stringify(repositories, null, 2)}}`
	);

	// Start the migration on GitHub
	const migration = await octokit.rest.migrations.startForOrg({
		org,
		repositories,
		lock_repositories: false
	});

	let { id: migration_id, state } = migration.data;

	info(
		`#${index} - Started successfully, migration id is ${migration_id} and the state is currently ${state}`
	);

	// Wait for status of migration to be exported
	while (state !== 'exported') {
		await sleep(30000);

		const check = await octokit.rest.migrations.getStatusForOrg({
			org,
			migration_id
		});

		state = check.data.state;
		info(`#${index} - State is ${state}...`);
	}

	info(
		`#${index} - State changed to ${state}, requesting download url of archive...`
	);

	// Fetches the URL to a migration archive
	const archive = await octokit.rest.migrations.downloadArchiveForOrg({
		org,
		migration_id
	});

	debug(archive.url);

	const filename = `${directory}/github_${githubOrganization}_${index}_${new Date().toJSON()}.tar.gz`;
	info(`#${index} - Downloading archive file to ${filename}...`);
	const writeStream = fs.createWriteStream(filename);
	const response = await http.get(archive.url);
	response.message.pipe(writeStream);

	async function write() {
		return new Promise((resolve, reject) => {
			writeStream.on('close', async () => {
				info(`#${index} - Download completed!`);
				resolve('complete');
			});
			writeStream.on('error', () => {
				error(`#${index} - Error while downloading file`);
				reject();
			});
		});
	}

	await write();

	// Deletes the migration archive. Migration archives are otherwise automatically deleted after seven days.
	info(`#${index} - Deleting organization migration archive from GitHub`);
	await octokit.rest.migrations.deleteArchiveForOrg({
		org,
		migration_id
	});

	return filename;
}

// Start the backup script
run(githubOrganization, githubRepository);
