import { execFileSync } from "child_process";
import { getInput, setFailed } from "@actions/core";
import { ECRClient, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";

const TAGS_SPLIT_REGEX = /\s+(?=([^"]*"[^"]*")*[^"]*$)/g;

async function main() {
    try {
        const action = getInput("action");
        const repositoryUrl = getInput("repository-url");
        const image = getInput("image");
        const tags = getInput("tags").split(TAGS_SPLIT_REGEX).filter(Boolean);

        const repositoryName = repositoryUrl.slice(repositoryUrl.lastIndexOf("/") + 1);

        const { user, password } = await getECRCredentials();
        execFileSync("docker", ["login", "--username", user, "--password-stdin", repositoryUrl], { input: password });

        if (action === "push") {
            const imageTag = image.split(":")[1] || "latest";
            const remoteImageName = `${repositoryUrl}:${imageTag}`;
            execFileSync("docker", ["tag", image, remoteImageName], { stdio: "inherit" });
            execFileSync("docker", ["push", remoteImageName], { stdio: "inherit" });

            if (tags.length) {
                tags.forEach((tag) => {
                    const [pushedImage, newTagImage] = [imageTag, tag].map((t) => {
                        const output = execFileSync("aws", [
                            "ecr", "batch-get-image",
                            "--repository-name", repositoryName,
                            "--image-ids", `imageTag=${t}`,
                            "--output", "json",
                        ], { encoding: "utf8" });
                        return JSON.parse(output)
                    })

                    if (pushedImage.images[0].imageId.imageDigest !== newTagImage?.images[0]?.imageId.imageDigest) {
                        execFileSync("aws", [
                            "ecr", "put-image",
                            "--repository-name", repositoryName,
                            "--image-tag", tag,
                            "--image-manifest", pushedImage.images[0].imageManifest,
                        ])
                    }
                });
            }
        }

        if (action === "pull") {
            const imageTag = image.split(":")[1] || "latest";
            const remoteImageName = `${repositoryUrl}:${imageTag}`;
            execFileSync("docker", ["pull", remoteImageName], { stdio: "inherit" });
            execFileSync("docker", ["tag", remoteImageName, image], { stdio: "inherit" });
            execFileSync("docker", ["rmi", remoteImageName], { stdio: "inherit" });

            if (tags.length) {
                const imageName = image.split(":")[0];
                tags.forEach((tag) => {
                    execFileSync("docker", ["tag", image, `${imageName}:${tag}`], { stdio: "inherit" });
                });
            }
        }

        execFileSync("docker", ["logout", repositoryUrl]);
    } catch (err) {
        if (err instanceof Error) setFailed(err);
    }
}

async function getECRCredentials() {
    const ecr = new ECRClient({});
    const getAuthorizationTokenCommand = new GetAuthorizationTokenCommand({});
    const response = await ecr.send(getAuthorizationTokenCommand)
    const token = response.authorizationData?.[0].authorizationToken;

    if (token === undefined) {
        throw Error("Failed to retrieve ECR authorization token.");
    }

    const [user, password] = Buffer.from(token, "base64").toString("utf8").split(":");
    return { user, password };
}

main();
