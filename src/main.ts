import {setOutput} from '@actions/core'
import {Octokit} from '@octokit/core'
import * as fs from 'fs'
import * as https from 'https'
import 'dotenv/config'

// All the GitHub variables
const githubOrganization: string = process.env.GH_ORG as string
const githubRepo: string = process.env.GH_REPO as string
const octokit = new Octokit({
    auth: process.env.GH_APIKEY
})

// Check if all the variables necessary are defined
export function check(githubOrganization: string): void {
    if (!githubOrganization) {
        throw new Error('GH_ORG is undefined')
    }
}

// Add sleep function to reduce calls to GitHub API when checking the status of the migration
async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// Main function for running the migration
async function run(organization: string, githubRepo?: string): Promise<void> {
    let repoNames: string[] = []

    if (githubRepo && githubRepo !== '') {
        repoNames = [githubRepo]
    } else {
        console.log('Get list of repositories...')

        let fetchMore = true
        let page = 1

        while (fetchMore) {
            const repos = await octokit.request('GET /orgs/{org}/repos', {
                org: organization,
                type: 'all',
                per_page: 100,
                sort: 'full_name',
                page: page++
            })
            repoNames = repoNames.concat(repos.data.map(item => item.full_name))
            fetchMore = repos.data.length >= 100
        }
    }

    console.log(repoNames)

    console.log('Starting migration...')

    // Start the migration on GitHub
    const migration = await octokit.request('POST /orgs/{org}/migrations', {
        org: organization,
        repositories: repoNames,
        lock_repositories: false
    })

    console.log(
        `Migration started successfully! \nThe current migration id is ${migration.data.id} and the state is currently on ${migration.data.state}`
    )

    // Need a migration status when entering the while loop for the first time
    let state = migration.data.state

    // Wait for status of migration to be exported
    while (state !== 'exported') {
        const check = await octokit.request(
            'GET /orgs/{org}/migrations/{migration_id}',
            {
                org: organization,
                migration_id: migration.data.id
            }
        )
        console.log(`State is ${check.data.state}... \n`)
        state = check.data.state
        await sleep(5000)
    }

    console.log(
        `State changed to ${state}! \nRequesting download url of archive...\n`
    )

    // Fetches the URL to a migration archive
    const archive = await octokit.request(
        'GET /orgs/{org}/migrations/{migration_id}/archive',
        {
            org: organization,
            migration_id: migration.data.id
        }
    )

    console.log(archive.url)

    // Function for deleting archive from Github
    async function deleteArchive(
        organization: string,
        migrationId: number
    ): Promise<void> {
        console.log('Deleting organization migration archive from GitHub')
        await octokit.request(
            'DELETE /orgs/{org}/migrations/{migration_id}/archive',
            {
                org: organization,
                migration_id: migrationId
            }
        )
    }

    // Function for downloading archive from Github S3 environment
    function downloadArchive(url: string, filename: string): void {
        https.get(url, res => {
            const writeStream = fs.createWriteStream(filename)
            console.log('\nDownloading archive file...')
            res.pipe(writeStream)

            writeStream.on('finish', () => {
                console.log('Download completed!')

                setOutput('backupFile', filename)

                // Deletes the migration archive. Migration archives are otherwise automatically deleted after seven days.
                deleteArchive(organization, migration.data.id)
                console.log('Backup completed! Goodbye.')
            })

            writeStream.on('error', () => {
                console.log('Error while downloading file')
            })
        })
    }

    // Create a name for the file which has the current date attached to it
    const filename = `gh_org_archive_${githubOrganization}_${new Date()
        .toJSON()
        .slice(0, 10)}.tar.gz`

    // Download archive from Github and upload it to our own S3 bucket
    downloadArchive(archive.url, filename)
}

// Check if all variables are defined
check(githubOrganization)

// Start the backup script
run(githubOrganization, githubRepo)
