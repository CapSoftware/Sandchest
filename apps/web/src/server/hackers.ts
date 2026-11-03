import { userHackers } from "@sandchest/db";
import { cache } from "react";
import { db } from "./db";

/** The hackers a person works with, read once per request: the header and the hacker's page share it. */
export const myHackers = cache((userId: string) => userHackers(db(), userId));
