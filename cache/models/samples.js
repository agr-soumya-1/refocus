/**
 * Copyright (c) 2017, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or
 * https://opensource.org/licenses/BSD-3-Clause
 */

/**
 * cache/models/samples.js
 */
'use strict'; // eslint-disable-line strict
const debugUpsertErrors = require('debug')('refocus:sample:upsert:errors');
const debugfindSamples = require('debug')('refocus:findSamples');
const Promise = require('bluebird');
const logInvalidHmsetValues = require('../../utils/common')
  .logInvalidHmsetValues;
const helper = require('../../api/v1/helpers/nouns/samples');
const u = require('../../api/v1/helpers/verbs/utils');
const modelUtils = require('./utils');
const sampleStore = require('../sampleStore');
const redisClient = require('../redisCache').client.sampleStore;
const constants = sampleStore.constants;
const redisErrors = require('../redisErrors');
const apiErrors = require('../../api/v1/apiErrors');
const sampleUtils = require('../../db/helpers/sampleUtils');
const dbConstants = require('../../db/constants');
const redisOps = require('../redisOps');
const db = require('../../db/index');
const fu = require('../../api/v1/helpers/verbs/findUtils.js');
const aspectType = redisOps.aspectType;
const subjectType = redisOps.subjectType;
const sampleType = redisOps.sampleType;
const commonUtils = require('../../utils/common');
const sampleNameSeparator = '|';
const logger = require('@salesforce/refocus-logging-client');
const featureToggles = require('feature-toggles');
const config = require('../../config');
const Op = require('sequelize').Op;

const sampFields = {
  PROVIDER: 'provider',
  USER: 'user',
  MSG_BODY: 'messageBody',
  MSG_CODE: 'messageCode',
  NAME: 'name',
  VALUE: 'value',
  RLINKS: 'relatedLinks',
  STATUS: 'status',
  PRVS_STATUS: 'previousStatus',
  STS_CHANGED_AT: 'statusChangedAt',
  CREATED_AT: 'createdAt',
  UPD_AT: 'updatedAt',
  ASP_ID: 'aspectId',
  SUBJ_ID: 'subjectId',
  OWNER: 'owner',
  OWNER_ID: 'ownerId',
};
const sampleFieldsArr = Object.keys(sampFields).map((key) => sampFields[key]);

const embeddedAspectFields = [
  'id', 'description', 'isPublished', 'helpEmail', 'helpUrl', 'name', 'timeout',
  'criticalRange', 'warningRange', 'infoRange', 'okRange', 'valueLabel',
  'valueType', 'relatedLinks', 'tags', 'rank',
];
const embeddedSubjectFields = [
  'absolutePath', 'childCount', 'createdAt', 'createdBy', 'description',
  'geolocation', 'helpEmail', 'helpUrl', 'hierarchyLevel', 'id', 'isPublished',
  'name', 'parentAbsolutePath', 'parentId', 'relatedLinks', 'sortBy', 'tags',
  'updatedAt',
];

const ZERO = 0;
const ONE = 1;
const TWO = 2;

/**
 * Parses a sample name into its separate parts, i.e. the subject absolute
 * path and the aspect name.
 *
 * @param {String} name - The sample name
 * @returns {Object} containing subject.absolutePath and aspect.name
 * @throws {ResourceNotFoundError} if the name cannot be split in two using
 *  sampleNameSeparator
 */
function parseName(name) {
  const retval = {
    subject: { absolutePath: undefined },
    aspect: { name: undefined },
  };
  const arr = (name || '').split(sampleNameSeparator);
  if (arr.length === 2) {
    retval.subject.absolutePath = arr[0];
    retval.aspect.name = arr[1];
    return retval;
  } else if (arr.length === 3) {
    retval.subject.absolutePath = arr[0];
    retval.aspect.name = arr[1] + sampleNameSeparator + arr[2];
    return retval;
  }

  logger.error(`see this - cache/models/samples.parseName|Invalid sample name "${name}"`);
  logger.verbose(new Error().stack);
  throw new redisErrors.ResourceNotFoundError({
    explanation: `Invalid sample name "${name}"`,
  });
} // parseName

/**
 * Checks if the user has the permission to perform the write operation on the
 * sample or not.

 * @param  {String}  aspectName - Aspect name
 * @param  {String}  userName -  User performing the operation
 * @param  {Boolean} isBulk   - Flag to indicate if the action is a bulk
 *  operation or not
 * @returns {Promise} - which resolves to true if the user has write permission
 * @throws {Error} - if user does not have writer permission
 */
function checkWritePermission(aspectName, userName, isBulk) {
  return redisOps.getAspectWriters({ name: aspectName })
  .then((res) =>
    hasWritePermission(res, aspectName, userName, isBulk)
  );
} // checkWritePermission

/**
 * Checks if the user has the permission to perform the write operation on the
 * sample or not.

 * @param  {Array<String>}  writers - Array of user names
 * @param  {String}  aspectName - Aspect name
 * @param  {String}  userName -  User performing the operation
 * @returns {Boolean} - true if the user has write permission
 * @throws {Error} - if user does not have writer permission
 */
function hasWritePermission(writers, aspectName, userName) {
  // empty writers arr would mean everyone has permission
  if (writers.length && !writers.includes(userName)) {
    throw new redisErrors.UpdateDeleteForbidden({
      explanation: `User "${userName}" does not have write permission ` +
        `for aspect "${aspectName}"`,
    });
  }

  return true;
} // hasWritePermission

/**
 * Convert array strings to Json for sample and aspect, then attach aspect to
 * sample.
 *
 * @param  {Object} sampleObj - Sample object from redis
 * @param  {Object} aspectObj - Aspect object from redis
 * @returns {Object} - Sample object with aspect attached
 */
function cleanAddAspectToSample(sampleObj, aspectObj) {
  let sampleRes = {};
  sampleRes = sampleStore.arrayObjsStringsToJson(sampleObj,
    constants.fieldsToStringify.sample);
  const aspect = sampleStore.arrayObjsStringsToJson(aspectObj,
    constants.fieldsToStringify.aspect);
  if (aspect) {
    modelUtils.removeExtraAttributes(aspect, embeddedAspectFields);
    sampleStore.convertAspectStrings(aspect);
    sampleRes.aspect = aspect;
    logger.info("cleaned sample object - " + JSON.stringify(sampleRes));
  }

  return sampleRes;
} // cleanAddAspectToSample

/**
 * Returns true if any attributes are being modified. (Don't bother comparing
 * the "name" attribute--the only difference would be uppercase/lowercase and
 * that should not be treated as a change.)
 *
 * @param {Object} newSample - received from query body
 * @param {Object} oldSample - from redis
 * @returns {Boolean} true if any sample attributes are being modified
 */
function isSampleChanged(newSample, oldSample) {
  function isKeyNewOrChanged(key) {
    return key !== 'name' &&
      (!oldSample.hasOwnProperty(key) || newSample[key] !== oldSample[key]);
  } // isKeyNewOrChanged

  // Use "some" because it stops evaluating as soon as it hits a truthy element
  return Object.keys(newSample).some(isKeyNewOrChanged);
} // isSampleChanged

/**
 * Convert array strings to Json for sample and subject, then attach subject to
 * sample.
 *
 * @param  {Object} sampleObj - Sample object from redis
 * @param  {Object} subjectObj - Subject object from redis
 * @returns {Object} - Sample object with subject attached
 */
function cleanAddSubjectToSample(sampleObj, subjectObj) {
  let sampleRes = {};
  sampleRes = sampleStore.arrayObjsStringsToJson(sampleObj,
    constants.fieldsToStringify.sample);
  const subject = sampleStore.arrayObjsStringsToJson(subjectObj,
    constants.fieldsToStringify.subject);
  if (subject) {
    modelUtils.removeExtraAttributes(subject, embeddedSubjectFields);
    sampleStore.convertSubjectStrings(subject);
    sampleRes.subject = subject;
  }

  return sampleRes;
} // cleanAddSubjectToSample

/**
 * Update the sample from the request body. Updates in place. Compares to the
 * previous state of the same sample, recalcuates status as needed.
 *
 * @param  {Object} curr - current sample (from request body)
 * @param  {Object} prev - previous sample
 * @param  {Object} status - result of status calculation
 */
function updateSampleAttributes(curr, prev, status) {
  modelUtils.removeExtraAttributes(curr, sampleFieldsArr);
  const now = new Date().toISOString();

  // avoid updating sample name (case sensitivity)
  if (prev && prev.name) {
    curr.name = prev.name;
  }

  if (!curr.hasOwnProperty(sampFields.VALUE)) {
    /*
     * If no value is provided and this is a new sample, set value to empty
     * string, which will generate a status of "Invalid". If this is NOT a new
     * sample, treat it like a PATCH and keep the value from the "prev" version
     * of the sample.
     */
    if (prev && prev.hasOwnProperty(sampFields.VALUE)) {
      curr[sampFields.VALUE] = prev[sampFields.VALUE];
    } else {
      curr[sampFields.VALUE] = '';
    }
  }

  /* Just in case curr.value was undefined... */
  if (curr[sampFields.VALUE] === undefined) curr[sampFields.VALUE] = '';

  if (!prev) {
    /*
     * This is a brand new sample so calculate current status based on value,
     * set previous status to invalid, and set status changed at to now.
     */
    curr[sampFields.STATUS] = status;
    curr[sampFields.PRVS_STATUS] = dbConstants.statuses.Invalid;
    curr[sampFields.STS_CHANGED_AT] = now;
  } else if (curr[sampFields.VALUE] === prev[sampFields.VALUE]) {
    /*
     * Value is same so no need to recalculate status. Just carry over the
     * status, previous status, and status changed at from the old sample.
     */
    curr[sampFields.STATUS] = prev[sampFields.STATUS];
    curr[sampFields.PRVS_STATUS] = prev[sampFields.PRVS_STATUS];
    curr[sampFields.STS_CHANGED_AT] = prev[sampFields.STS_CHANGED_AT];
  } else {
    /*
     * The value is different so we need to calculate the status.
     */
    curr[sampFields.STATUS] = status;
    if (curr[sampFields.STATUS] === prev[sampFields.STATUS]) {
      /*
       * The status is the same so carry over the previous status and status
       * changed at from the old sample.
       */
      curr[sampFields.PRVS_STATUS] = prev[sampFields.PRVS_STATUS];
      curr[sampFields.STS_CHANGED_AT] = prev[sampFields.STS_CHANGED_AT];
    } else {
      /*
       * The status is different so assign previous status based on the old
       * sample's status, and set status changd at to now.
       */
      curr[sampFields.PRVS_STATUS] = prev[sampFields.STATUS];
      curr[sampFields.STS_CHANGED_AT] = now;
    }
  }

  let rlinks;

  // if related link is passed in query object
  if (curr[sampFields.RLINKS]) {
    rlinks = curr[sampFields.RLINKS];
  } else if (!prev) { // if we are creating new sample
    rlinks = []; // default value
  } else if (prev[sampFields.RLINKS] && prev[sampFields.RLINKS] !== '[]') {
    /* retain previous related links if query body does not have attribute */
    rlinks = JSON.parse(prev[sampFields.RLINKS]);
  }

  if (rlinks) {
    curr[sampFields.RLINKS] = JSON.stringify(rlinks);
  } else {
    /* safeguard against sending null argument to hmset command */
    delete curr[sampFields.RLINKS];
  }

  if (!prev) curr[sampFields.CREATED_AT] = now;
  curr[sampFields.UPD_AT] = now;
} // updateSampleAttributes

/**
 * Throws custom error object based on object type for sample upsert.
 *
 * @param  {String}  objectType - Object type - subject or aspect
 * @param  {String} sampleName - The sample name
 * @throws {Object} Error object
 */
function handleUpsertError(objectType, sampleName) {
  const err = new redisErrors.ResourceNotFoundError({
    explanation: `${objectType} for this sample was not found or has ` +
      'isPublished=false',
  });

  if (sampleName) err.sample = sampleName;

  throw err;
} // handleUpsertError

/**
 * Returns a sample object along with its related aspect; given a sample name.
 * @param  {String} sampleName - Name of the sample
 * @returns {Object} - Sample Object
 */
function getOneSample(sampleName) {
  const parsedSampleName = parseName(sampleName); // throw is invalid name
  const commands = [];
  commands.push([
    'hgetall',
    sampleStore.toKey(constants.objectType.sample, sampleName),
  ]);

  // command to get aspect
  commands.push([
    'hgetall',
    sampleStore.toKey(constants.objectType.aspect,
      parsedSampleName.aspect.name),
  ]);

  return redisClient.batch(commands).execAsync();
} // getOneSample

/**
 * Prepare sample for upsert
 *
 * @param  {Object}  newSample - The sample to be upserted
 * @param  {Object} sampleAttributes - Associated values required for upsert and publish
 * @param {Object} user - The user performing the write operation
 * @throws {Object} Error object
 */
function prepareSampleForUpsert(newSample, sampleAttributes, user) {
  const { subjectExists, aspectExists, aspectWriters, existingSample, sampleStatus }
    = sampleAttributes;

  const userName = user ? user.name : false;
  const sampleName = newSample.name;

  const parsedName = parseName(sampleName);
  const aspectName = parsedName.aspect.name.split('|')[0];

  newSample.status = sampleStatus;

  // check write permission
  hasWritePermission(aspectWriters, aspectName, userName);

  // check that subject is published
  if (!subjectExists) {
    handleUpsertError(constants.objectType.subject, sampleName);
  }

  // check that aspect is published
  if (!aspectExists) {
    handleUpsertError(constants.objectType.aspect, sampleName);
  }

  // check whether the sample has been changed
  if (existingSample && !isSampleChanged(newSample, existingSample)) {
    /* Sample is not new AND nothing has changed */
    sampleAttributes.noChange = true;
  }

  // sampleQueryBodyObj updated with fields
  updateSampleAttributes(newSample, existingSample, newSample.status);
}

/**
 * Prepare sample for publish
 *
 * @param  {Object}  sample - The sample to be published
 * @param  {Object} sampleAttributes - Associated values required for upsert and publish
 * @throws {Object} Error object
 */
function prepareSampleForPublish(sample, sampleAttributes) {
  const parsedName = parseName(sample.name);

  // attach props for perspective filtering
  sample.absolutePath = parsedName.subject.absolutePath;
  sample.subject = {
    absolutePath: parsedName.subject.absolutePath,
    tags: sampleAttributes.subjectTags,
  };
  sample.aspect = {
    name: parsedName.aspect.name,
    tags: sampleAttributes.aspectTags,
  };

  return sample;
}

/**
 * Upsert multiple samples.
 *
 * @param  {Array} samplesAndAttributes - Array of objects with props
 *   "newSample" and "sampleAttributes"
 * @param {Object} user - The user performing the write operation
 * @returns {Object} - Updated sample
 */
function upsertSamples(samplesAndAttributes, user) {
  const allSamples = (
    samplesAndAttributes
    .map(({ newSample }) => newSample)
  );

  const allSampleNames = allSamples.map(s => s.name);

  const existingSamples = (
    samplesAndAttributes
    .filter(({ newSample, sampleAttributes }) =>
      sampleAttributes.existingSample
    )
    .map(({ newSample }) => newSample)
  );

  const newSamples = (
    samplesAndAttributes
    .filter(({ newSample, sampleAttributes }) =>
      !sampleAttributes.existingSample
    )
    .map(({ newSample }) => newSample)
  );

  const batch = redisOps.batchCmds();

  // existing samples: just update sample
  batch.map(existingSamples, (batch, newSample) =>
    batch.setHashMulti(constants.objectType.sample, newSample.name, newSample)
  );

  // new samples: setup necessary fields and create sample
  batch.map(newSamples, (batch, newSample) => {
    const parsedName = parseName(newSample.name);
    const absolutePath = parsedName.subject.absolutePath;
    const aspectName = parsedName.aspect.name;

    if (user) {
      // Add the provider and user fields.
      newSample.provider = user.id;
      newSample.user = JSON.stringify({
        name: user.name,
        email: user.email,
        profile: {
          name: user.profile.name,
        },
      });
    }

    return batch

    // add the aspect name to the subject-to-aspect resource mapping
    .addAspectInSubjSet(absolutePath, aspectName)

    // add sample to the master list of sample index
    .addKeyToIndex(sampleType, newSample.name)

    // add child aspect to the Parent-Child relationship map
    .addChildAspectToParentAspectSet(aspectName)

    // create/update hash of sample. Check and log invalid Hmset values
    .setHashMulti(sampleType, newSample.name, newSample)

    // add subject absolute path to aspect-to-subject resource mapping
    .addSubjectAbsPathInAspectSet(aspectName, absolutePath);
  });
  logger.info("allSampleNames = " + JSON.stringify(allSampleNames) + '\n');
  // all samples: get updated hash
  batch.returnAll(allSampleNames, 'updatedSamples', (batch, sampleName) =>
    batch.getHash(constants.objectType.sample, sampleName)
  );

  return batch.exec()
  .then(({ updatedSamples }) =>
    updatedSamples.map((updatedSample, i) => {
      const { sampleAttributes } = samplesAndAttributes[i];

      sampleStore.arrayObjsStringsToJson(updatedSample, constants.fieldsToStringify.sample);

      if (sampleAttributes.noChange) {
        updatedSample.noChange = true;
      }

      return updatedSample;
    })
  );
}

function upsertOneSample(sample, sampleAttributes, user) {
  return upsertSamples([{ newSample: sample, sampleAttributes }], user)
  .then(([upsertedSample]) => {
    if (upsertedSample instanceof Error) {
      throw upsertedSample;
    } else {
      return upsertedSample;
    }
  });
}

/**
 * Get all values from redis that are required to upsert and publish the samples.
 *
 * @param  {Array} samplesReq - Array of samples.
 * @returns {Array} - Array of Objects containing attributes:
 *   aspectWriters, aspectTags, aspectExists, subjectTags, subjectExists,
 *   existingSample, sampleStatus
 */
function getValuesForSamples(samplesReq) {
  const parsedNames = samplesReq.map((squery) =>
    parseName(squery.name.toLowerCase())
  );

  let aspNames = parsedNames.map(({ aspect }) => aspect.name.split('|')[0]);
  aspNames = Array.from(new Set(aspNames));

  let absPaths = parsedNames.map(({ subject }) => subject.absolutePath);
  absPaths = Array.from(new Set(absPaths));

  return redisOps.batchCmds()

  // aspect values
  .returnAll(aspNames, 'aspectsWriters', (batch, aspName) =>
    batch.getAspectWriters({ name: aspName })
  )
  .returnAll(aspNames, 'aspectsTags', (batch, aspName) =>
    batch.getAspectTags({ name: aspName })
  )
  .returnAll(aspNames, 'aspectsExist', (batch, aspName) =>
    batch.aspectExists({ name: aspName })
  )

  // subject values
  .returnAll(absPaths, 'subjectsTags', (batch, absPath) =>
    batch.getSubjectTags({ absolutePath: absPath })
  )
  .returnAll(absPaths, 'subjectsExist', (batch, absPath) =>
    batch.subjectExists({ absolutePath: absPath })
  )

  // sample values
  .returnAll(samplesReq, 'existingSamples', (batch, sample) =>
    batch.getHash(constants.objectType.sample, sample.name)
  )
  .returnAll(samplesReq, 'samplesStatus', (batch, sample) =>
    batch.calculateSampleStatus(sample.name, sample.value)
  )

  .exec()

  .then((sampleAttributes) => {
    logger.info("sampleAttributes - " + JSON.stringify(sampleAttributes));
    const aspMap = aspNames.reduce((aspMap, aspName, i) => ({
      [aspName]: {
        aspectWriters: sampleAttributes.aspectsWriters[i],
        aspectTags: sampleAttributes.aspectsTags[i],
        aspectExists: sampleAttributes.aspectsExist[i],
      },
      ...aspMap,
    }), {});

    const subMap = absPaths.reduce((subMap, absPath, i) => ({
      [absPath]: {
        subjectTags: sampleAttributes.subjectsTags[i],
        subjectExists: sampleAttributes.subjectsExist[i],
      },
      ...subMap,
    }), {});

    logger.info("aspMap - " + JSON.stringify(aspMap));
    logger.info("subMap - " + JSON.stringify(subMap))
    return samplesReq.map((sample, i) => {
      const aspName = parsedNames[i].aspect.name.split('|')[0];
      const absPath = parsedNames[i].subject.absolutePath;
      return {
        subjectTags: subMap[absPath].subjectTags,
        subjectExists: subMap[absPath].subjectExists,
        aspectWriters: aspMap[aspName].aspectWriters,
        aspectTags: aspMap[aspName].aspectTags,
        aspectExists: aspMap[aspName].aspectExists,
        existingSample: sampleAttributes.existingSamples[i],
        sampleStatus: sampleAttributes.samplesStatus[i],
      };
    });
  });
}

/**
 * Check if sample name is valid. Apply attributes filter to samples.
 * Then clean and attach aspect to sample. Add links and return.
 * @param samples - Samples array
 * @param opts - Filter options
 * @param sampAspectMap - map of sample name -> aspect object
 * @param reqMethod - Request method
 * @returns {Array} - Filtered samples
 */
function applyAttributesFilter(samples, opts, sampAspectMap, reqMethod) {
  return samples.map((sample) => {
    parseName(sample.name); // throw if invalid name
    const aspect = sampAspectMap[sample.name];

    if (opts.attributes) { // delete sample fields, hence no return obj
      debugfindSamples('applyAttributesFilter: %o', opts.attributes);
      modelUtils.applyFieldListFilter(sample, opts.attributes);
    }

    const s = cleanAddAspectToSample(sample, aspect);
    s.apiLinks = u.getApiLinks(s.name, helper, reqMethod);
    return s;
  });
}

/**
 * @param sampleKeys - Sample keys array
 * @returns {Array} - Samples and aspects array
 */
function getSamplesAndAspects(sampleKeys) {
  const commands = [];
  sampleKeys.forEach((sKey) => {

    var aNameSplit = sKey.split('|');
    var aName = aNameSplit[1];
    if(aNameSplit.length == 3) {
      aName += '|' + aNameSplit[2];
    }
    
    const aKey = sampleStore.toKey(constants.objectType.aspect, aName);
    commands.push(['hgetall', sKey.toLowerCase()]);
    commands.push(['hgetall', aKey.toLowerCase()]);
  });

  debugfindSamples('Getting samples and aspects. Commands size: %d',
    commands.length);
  return redisClient.batch(commands).execAsync();
}

/**
 * Create samples array and sample name -> aspect map from an array of samples
 * and aspects
 * @param samplesAndAspects - Sample and aspects array
 * @returns {{sampAspectMap, samples: Array}}
 */
function assembleSampleAspects(samplesAndAspects) {
  const samples = [];

  // e.g { samplename: asp object }, so that we can attach aspect later
  const sampAspectMap = {};
  for (let num = 0; num < samplesAndAspects.length; num += TWO) {
    const sample = samplesAndAspects[num];
    const aspect = samplesAndAspects[num + ONE];
    if (sample && aspect) {
      samples.push(sample);
      sampAspectMap[sample.name] = aspect;
    }
  }

  return { samples, sampAspectMap };
}

/**
 * Get filtered sample keys in batches using redis sscan operation.
 * @param cursor - starting position of batch
 * @param filteredSamples - Array object to be updated in each batch
 * @param opts - Filter options
 * @returns {Array} - An Array of filtered samples
 */
function sscanAndFilterSampleKeys(cursor, filteredSamples, opts) {
  return redisClient.sscanAsync(constants.indexKey.sample, cursor,
    'COUNT', config.findSamplesSscanCount)
    .then((reply) => {
      const newCursor = reply[0];
      debugfindSamples('sscanAndFilterSampleKeys - previous cursor: %s, ' +
        'new cursor: %s, filteredSamples length: %d', cursor, newCursor,
        filteredSamples.size);
      const sampleKeys = reply[1];

      let keys = sampleKeys;
      if (opts.filter && opts.filter.name) {
        keys = modelUtils.filterSampleKeysByName(sampleKeys, opts);
      }

      keys.forEach((key) => {
        filteredSamples.add(key);
      });

      if (newCursor === '0') {
        debugfindSamples('sscanAndFilterSampleKeys: returning samples ' +
          'size: %d', filteredSamples.size);
        return Array.from(filteredSamples);
      }

      return sscanAndFilterSampleKeys(newCursor, filteredSamples, opts);
    });
}

module.exports = {

  /**
   * Delete sample. Get sample. If found, get aspect, delete sample entry from
   * sample index, delete aspect from subject set and delete sample hash. If
   * sample not found, throw Not found error.
   * @param  {String} sampleName - Sample name
   * @param {String} userName - The user performing the write operation
   * @returns {Promise} - Resolves to a sample object
   */
  deleteSample(sampleName, userName) {
    let parsedSampleName = {};
    try {
      parsedSampleName = parseName(sampleName.toLowerCase());
    } catch (err) {
      return Promise.reject(err);
    }

    const subjAbsPath = parsedSampleName.subject.absolutePath;
    const aspName = parsedSampleName.aspect.name;
    let sampObjToReturn;
    return redisOps.getHash(sampleType, sampleName)
    .then((sampleObj) => {
      if (!sampleObj) {
        throw new redisErrors.ResourceNotFoundError({
          explanation: 'Sample not found.',
        });
      }

      sampObjToReturn = sampleObj;
      sampObjToReturn.updatedAt = new Date().toISOString();

      return checkWritePermission(aspName, userName);
    })

    /*
     * Set up and execute the commands to:
     * (1) delete the sample entry from the master list of sample index,
     * (2) delete the aspect from the subAspMap,
     * (3) delete the subject from aspect-to-subject mapping
     * (4) delete the sample hash.
     */
    .then(() =>
      redisOps.batchCmds()
        .delKeyFromIndex(sampleType, sampleName)
        .delAspFromSubjSet(subjAbsPath, aspName)
        .delSubFromAspSet(aspName, subjAbsPath)
        .delHash(sampleType, sampleName)
        .exec()
    )
    .then(() => sampleStore.arrayObjsStringsToJson(sampObjToReturn,
        constants.fieldsToStringify.sample));
  }, // deleteSample

  /**
   * Delete sample related links
   * @param  {Object} params - Request parameters
   * @param {String} userName - The user performing the write operation
   * @returns {Promise} - Resolves to a sample object
   */
  deleteSampleRelatedLinks(params, userName) {
    const sampleName = params.key.value;
    const parsedSampleName = parseName(sampleName);
    const aspectName = parsedSampleName.aspect.name;
    const now = new Date().toISOString();
    let currSampObj;
    return redisOps.getHash(sampleType, sampleName)
    .then((sampObj) => {
      if (!sampObj) {
        throw new redisErrors.ResourceNotFoundError({
          explanation: 'Sample not found.',
        });
      }

      currSampObj = sampObj;
      return checkWritePermission(aspectName, userName);
    })
    .then(() => {
      let updatedRlinks = [];
      if (params.relName) { // delete only this related link
        const currRlinks = JSON.parse(currSampObj.relatedLinks);
        updatedRlinks = u.deleteAJsonArrayElement(
          currRlinks, params.relName.value
        );
      }

      // if no change in related links, then return the object.
      if (JSON.stringify(updatedRlinks) ===
        JSON.stringify(currSampObj.relatedLinks)) {
        Promise.resolve(sampleStore.arrayObjsStringsToJson(currSampObj,
          constants.fieldsToStringify.sample));
      }

      const hmsetObj = {};
      hmsetObj.relatedLinks = updatedRlinks;
      hmsetObj.updatedAt = now;

      // stringify arrays
      constants.fieldsToStringify.sample.forEach((field) => {
        if (hmsetObj[field]) {
          hmsetObj[field] = JSON.stringify(hmsetObj[field]);
        }
      });

      return redisOps.setHashMulti(sampleType, sampleName, hmsetObj);
    })
    .then(() => redisOps.getHash(sampleType, sampleName))
      .then((updatedSamp) => sampleStore.arrayObjsStringsToJson(updatedSamp,
        constants.fieldsToStringify.sample));
  }, // deleteSampleRelatedLinks

  isSampleChanged, // export for testing only

  /**
   * Patch sample. First get sample. If not found, throw error. Get aspect.
   * Update request body with required fields based on value and related links
   * if needed. Update sample. Then get updated sample, attach aspect and return
   * response. Note: Message body and message code will be updated if provided,
   * else no fields for message body/message code in redis object.
   *
   * @param  {Object} params - Request parameters
   * @param {String} userName - The user performing the write operation
   * @returns {Promise} - Resolves to a sample object
   */
  patchSample(params, userName) {
    const now = new Date().toISOString();
    const reqBody = params.queryBody.value;
    const sampleName = params.key.value;
    const parsedSampleName = parseName(sampleName.toLowerCase());
    const aspectName = parsedSampleName.aspect.name;
    let currSampObj;
    return checkWritePermission(aspectName, userName)
    .then(() => redisOps.getHash(sampleType, sampleName))
    .then((sampObj) => {
      if (!sampObj) {
        throw new redisErrors.ResourceNotFoundError({
          explanation: 'Sample not found.',
        });
      }

      currSampObj = sampObj;
      modelUtils.removeExtraAttributes(reqBody, sampleFieldsArr);
    })
    .then(() => {
      if (reqBody.value) {
        return redisOps.calculateSampleStatus(sampleName, reqBody.value)
          .then((status) => {
            if (currSampObj[sampFields.STATUS] !== status) {
              reqBody[sampFields.PRVS_STATUS] = currSampObj[sampFields.STATUS];
              reqBody[sampFields.STS_CHANGED_AT] = now;
              reqBody[sampFields.STATUS] = status;
            }

            reqBody[sampFields.UPD_AT] = now;
          });
      }

      return Promise.resolve();
    })
    .then(() => {
      if (reqBody.relatedLinks) {
        reqBody[sampFields.RLINKS] = reqBody.relatedLinks;
      }

      // stringify arrays
      constants.fieldsToStringify.sample.forEach((field) => {
        if (reqBody[field]) {
          reqBody[field] = JSON.stringify(reqBody[field]);
        }
      });

      return redisOps.setHashMulti(sampleType, sampleName, reqBody);
    })
    .then(() => redisOps.getHash(sampleType, sampleName))
    .then((updatedSamp) => {
      parseName(updatedSamp.name); // throw if invalid name
      return sampleStore.arrayObjsStringsToJson(updatedSamp,
        constants.fieldsToStringify.sample);
    })
    .catch((err) => {
      throw err;
    });
  }, // patchSample

  /**
   * Post sample. First get subject from db, then get aspect from db, then try
   * to get sample from Redis. Is sample found, throw error, else create
   * sample. Update sample index and subject set as well.
   * @param  {Object} reqBody - The sample object to be created
   * @param {Object} userObj - The user performing the write operation
   * @returns {Promise} - Resolves to a sample object
   */
  postSample(reqBody, userObj) {
    const now = new Date().toISOString();
    const userName = userObj ? userObj.name : false;
    const cmds = [];
    let subject;
    let sampleName;
    let aspectObj;

    return db.Subject.findByPk(reqBody.subjectId)
    .then((subjFromDb) => {
      if (!subjFromDb || !subjFromDb.isPublished) {
        throw new redisErrors.ResourceNotFoundError({
          explanation: `Subject "${reqBody.subjectId}" not found.`,
        });
      }

      subject = subjFromDb;
      return db.Aspect.findByPk(reqBody.aspectId);
    })
    .then((aspFromDb) => {
      if (!aspFromDb || !aspFromDb.isPublished) {
        throw new redisErrors.ResourceNotFoundError({
          explanation: `Aspect "${reqBody.aspectId}" not found.`,
        });
      }

      aspectObj = aspFromDb;
      return aspFromDb.isWritableBy(userName);
    })
    .then((isWritable) => {
      sampleName = subject.absolutePath + '|' + aspectObj.name;
      if (!isWritable) {
        const err = new redisErrors.UpdateDeleteForbidden({
          explanation: `User "${userName}" does not have write permission ` +
            `for aspect "${aspectObj.name}"`,
        });
        return Promise.reject(err);
      }

      return redisOps.getHash(sampleType, sampleName);
    })
    .then((sampFromRedis) => {
      if (sampFromRedis) {
        throw new apiErrors.DuplicateResourceError({
          explanation: `Sample "${sampFromRedis.name}" already exists.`,
        });
      }

      modelUtils.removeExtraAttributes(reqBody, sampleFieldsArr);
      reqBody.name = sampleName;
      return redisOps.calculateSampleStatus(reqBody.name, reqBody.value);
    })
    .then((status) => {
      const value = reqBody.value || '';
      reqBody[sampFields.STATUS] = status;
      reqBody[sampFields.VALUE] = value;
      if (reqBody.relatedLinks) {
        reqBody[sampFields.RLINKS] = JSON.stringify(reqBody.relatedLinks);
      } else {
        reqBody[sampFields.RLINKS] = '[]';
      }

      // defaults
      reqBody[sampFields.PRVS_STATUS] = dbConstants.statuses.Invalid;
      reqBody[sampFields.STS_CHANGED_AT] = now;
      reqBody[sampFields.UPD_AT] = now;
      reqBody[sampFields.CREATED_AT] = now;
      if (userObj) {
        reqBody[sampFields.PROVIDER] = userObj.id;
        reqBody[sampFields.USER] = JSON.stringify({
          name: userName,
          email: userObj.email,
          profile: {
            name: userObj.profile.name,
          },
        });
      }

      return redisOps.batchCmds()

        // add the aspect to the subjectSet
        .addAspectInSubjSet(subject.absolutePath, aspectObj.name)

        // add subject absolute path to aspect-to-subject resource mapping
        .addSubjectAbsPathInAspectSet(aspectObj.name, subject.absolutePath)

        // add sample to the master list of sample index
        .addKeyToIndex(sampleType, sampleName)

        // create a sample set to store the values
        .setHashMulti(sampleType, sampleName, reqBody)

        .exec();
    })
    .then(() => redisOps.getHash(sampleType, sampleName))
    .then((sampleObj) => sampleStore.arrayObjsStringsToJson(
      sampleObj, constants.fieldsToStringify.sample));
  }, // postSample

  /**
   * Put sample. First get sample. If not found, throw error. Get aspect.
   * Update request body with required fields based on value and related links
   * if needed. Delete message body and message code fields from hash
   * if not provided because they will be null. Then update sample.
   *
   * @param  {Object} params - Request parameters
   * @param {String} userName - The user performing the write operation
   * @returns {Promise} - Resolves to a sample object
   */
  putSample(params, userName) {
    const now = new Date().toISOString();
    const reqBody = params.queryBody.value;
    const sampleName = params.key.value;
    const parsedSampleName = parseName(sampleName);
    const aspectName = parsedSampleName.aspect.name;
    let value = '';
    let currSampObj;
    return redisOps.getHash(sampleType, sampleName)
    .then((sampObj) => {
      if (!sampObj) {
        throw new redisErrors.ResourceNotFoundError({
          explanation: 'Sample not found.',
        });
      }

      currSampObj = sampObj;
      return checkWritePermission(aspectName, userName);
    })
    .then(() => {
      modelUtils.removeExtraAttributes(reqBody, sampleFieldsArr);
      if (reqBody.value) {
        value = reqBody.value;
      }

      // change these only if status is updated
      return redisOps.calculateSampleStatus(sampleName, value);
    })
    .then((status) => {
      if (currSampObj[sampFields.STATUS] !== status) {
        reqBody[sampFields.PRVS_STATUS] = currSampObj[sampFields.STATUS];
        reqBody[sampFields.STS_CHANGED_AT] = now;
        reqBody[sampFields.STATUS] = status;
      }

      // We have a value, so update value and updated_at always.
      reqBody[sampFields.VALUE] = value;
      reqBody[sampFields.UPD_AT] = now;

      if (reqBody.relatedLinks) { // related links
        reqBody[sampFields.RLINKS] = JSON.stringify(reqBody.relatedLinks);
      } else {
        reqBody[sampFields.RLINKS] = '[]';
      }

      return redisOps.batchCmds()

        // delete fields with future null value
        .if(!reqBody.messageBody, (batch) =>
          batch
          .delHashField(sampleType, sampleName, sampFields.MSG_BODY)
          .delHashField(sampleType, sampleName, sampFields.MSG_CODE)
        )

        .setHashMulti(sampleType, sampleName, reqBody)
        .exec();
    })
    .then(() => redisOps.getHash(sampleType, sampleName))
    .then((updatedSamp) => {
      parseName(updatedSamp.name); // throw if invalid name
      return sampleStore.arrayObjsStringsToJson(updatedSamp,
        constants.fieldsToStringify.sample);
    });
  }, // putSample

  getOneSample, // exported for testing only

  /**
   * Retrieves the sample from redis and sends it back in the response. Get
   * sample and corresponsing aspect from redis and then apply field list
   * filter if needed. Then attach aspect to sample and return.
   *
   * @param  {String} params - Req Query parameters
   * @returns {Promise} - Resolves to a sample object
   */
  getSample(params) {
    const sampleName = params.key.value.toLowerCase();
    return getOneSample(sampleName)
    .then((responses) => {
      const sample = responses[ZERO];
      const aspect = responses[ONE];
      if (!sample || !aspect) {
        throw new redisErrors.ResourceNotFoundError({
          explanation: 'Sample/Aspect not found.',
        });
      }

      const opts = modelUtils.getOptionsFromReq(params, helper);
      if (opts.attributes) { // apply fields list filter
        modelUtils.applyFieldListFilter(sample, opts.attributes);
      }

      parseName(sampleName); // throw if invalid name
      const sampleRes = cleanAddAspectToSample(sample, aspect);
      return sampleRes;
    });
  }, // getSample

  /**
   * If feature toggle optimizeSampleFilteredGets enabled:
   * Finds samples with filter options if provided.
   * We handle three use cases:
   * 1. No filter: eg /samples
   * 2. Filter by name without wildcards: eg /samples?name=s1,s2
   * 3. Filter by other attributes: eg /samples?status=Critical
   *
   * Example options:
   * { attributes: [ 'name', 'status', 'value', 'id' ],
   *   order: [ '-value', 'status' ],
   *   limit: 5,
   *   offset: 1,
   *   filter: { name: '___Subject1.___Subject2*' }
   * }
   *
   * Note: Comma separated values will be considered as one value for:
   * - Wildcard values
   * - Non wildcard values other than name
   *
   * If feature toggle optimizeSampleFilteredGets disabled:
   * Finds samples with filter options if provided. We get sample keys from
   * redis using default alphabetical order. Then we apply limit/offset and
   * wildcard expr on sample names. Using filtered keys we get samples and
   * corresponding aspects from redis in an array. We create samples array and
   * { sampleName: aspect object} map from response. Then, we apply wildcard
   * expr (other than name) to samples array, then we sort, then apply
   * limit/offset and finally field list filters. Then, attach aspect to sample
   * using map we created and add to response array.
   *
   * @param  {Object} req - Request object
   * @param  {Object} res - Result object
   * @returns {Promise} - Resolves to a list of all samples objects
   */
  findSamples(req, res) {
    const opts = modelUtils.getOptionsFromReq(req.swagger.params, helper);
    logger.info('findSamples - opts' + JSON.stringify(opts));

    // Add prev/next response links.
    res.links({
      prev: req.originalUrl,
      next: fu.getNextUrl(req.originalUrl, opts.limit, opts.offset),
    });

    const hasOrder = opts.order && opts.order.length > 0;

    if (featureToggles.isFeatureEnabled('optimizeSampleFilteredGets')) {
      debugfindSamples('toggle optimizeSampleFilteredGets enabled. ' +
        'Filter options: %o', opts);
      const filterKeys = Object.keys(opts.filter);
      const hasFilter = filterKeys.length > 0;
      const hasNameFilterOnly = filterKeys.length === 1 && opts.filter.name;

      /**
       * Apply following logic when options have no filter and no sorting/sorting
       * only by name.
       * Get samplesKeys from sample set.
       * Sort if sorting default or by name
       * Apply limit/offset
       * Get sample hashes, apply attributes filter, cleanup and
       * return all samples.
       */
      const shouldGetAllKeys = !hasFilter &&
        (!hasOrder || opts.order === ['name'] || opts.order === ['-name']);

      if (shouldGetAllKeys) {
        debugfindSamples('Case 1: Getting all the keys. Then sort, apply ' +
          'limit/offset and attributes filter');
        return redisClient.smembersAsync(sampleStore.constants.indexKey.sample)
          .then((sampleKeys) => {
            sampleKeys.sort();

            if (opts.order === ['-name']) {
              sampleKeys.reverse();
            }

            const filteredSampleKeys = modelUtils.applyLimitAndOffset(
              opts, sampleKeys);
            return getSamplesAndAspects(filteredSampleKeys);
          })
          .then((samplesAndAspects) => {
            const { samples, sampAspectMap } =
              assembleSampleAspects(samplesAndAspects);
            return applyAttributesFilter(samples, opts,
              sampAspectMap, req.method);
          });
      }

      /**
       * Name filter and no wildcards:
       * If {filter: { name: 's1|a1'}}
       *  get one sample
       *
       * If { filter: { name: 's1|a1, s2|a2'}}
       *  get the samples with comma separated names
       *  If default name order, sort the array of sample names
       *  Apply limit and offset
       *  Get samples
       *
       * Then,
       * If order other than name, then sort and apply limit/offset
       * apply attributes filter, cleanup and return
       *
       */
      if (hasNameFilterOnly && !opts.filter.name.includes('*')) {
        let nameFilterArr = opts.filter.name.split(',').map((item) =>
          item.trim());
        debugfindSamples('Case 2: Name filter only and no wildcards. ' +
          'nameFilterArr: %o', nameFilterArr);
        return Promise.resolve()
          .then(() => {
            if (nameFilterArr.length === 1) { // one sample
              debugfindSamples('Get one sample: %s', nameFilterArr[0]);
              return getOneSample(nameFilterArr[0])
                .then(([samp, asp]) => samp && asp ? [samp, asp] : []);
            }

            if (!hasOrder || opts.order === ['name']) {
              nameFilterArr.sort();
              nameFilterArr = modelUtils.applyLimitAndOffset(
                opts, nameFilterArr);
              debugfindSamples('Sort and applyLimitAndOffset: Samples arr: %o',
                nameFilterArr);
            }

            // multiple samples
            const sampleKeys = nameFilterArr.map((name) =>
              sampleStore.toKey(constants.objectType.sample, name));
            debugfindSamples('Get multiple samples by name from redis');
            return getSamplesAndAspects(sampleKeys);
          })
          .then((samplesAndAspects) => {
            let { samples, sampAspectMap } =
              assembleSampleAspects(samplesAndAspects);

            if (samples.length > 1 && hasOrder && opts.order !== ['name']) {
              let filteredSamples = modelUtils.sortByOrder(samples, opts.order);
              filteredSamples = modelUtils.applyLimitAndOffset(
                opts, filteredSamples);
              debugfindSamples('Sort order other than name: %o. Applied ' +
                'limit/offset. Samples arr size: %d', opts.order,
                filteredSamples.length);
              samples = filteredSamples;
            }

            return applyAttributesFilter(samples, opts,
              sampAspectMap, req.method);
          });
      }

      /**
       * Filters other than name and possibly with wildcards.
       *  If sample wilcard has either subject or aspect name, use aspect subject
       *  maps to filter samples keys
       *  Else, use sscan to get sample keys in batches.
       *    Apply wildcard filter to the key batches and return consolidated list
       *    of filtered sample keys
       * If we need to sort by name only,
       *    Sort the list of filtered sample keys.
       *    Apply limit and offset if we need to filter by name only
       * Get the samples from cache
       *    Apply filters on sample objects (sort and apply limit only if not already sorted
       *    by name before)
       *    Apply attributes filter, clean samples, attach aspects and return
       *    samples
       */
      debugfindSamples('Case 3: Filters other than name and possibly with' +
        ' wildcards');
      return Promise.resolve()
        .then(() => {
          if (opts.filter && opts.filter.name) {
            const subjAsp = opts.filter.name.split('|');
            if (subjAsp.length === 2) {
              const isSubjWildCard = subjAsp[0].includes('*');
              const isAspWildCard = subjAsp[1].includes('*');
              if (isSubjWildCard && !isAspWildCard) {
                debugfindSamples('subject has wildcard: %s', subjAsp[0]);
                return modelUtils.getSampleKeysUsingMaps(subjAsp, false);
              } else if (!isSubjWildCard && isAspWildCard) {
                debugfindSamples('aspect has wildcard: %s', subjAsp[1]);
                return modelUtils.getSampleKeysUsingMaps(subjAsp, true);
              }
            }
          }

          const filteredSampleKeys = new Set();
          return sscanAndFilterSampleKeys('0', filteredSampleKeys, opts);
        })
        .then((filteredKeys) => {
          let keys = filteredKeys;

          if (hasNameFilterOnly) {
            if (!hasOrder || opts.order === ['name']) {
              filteredKeys.sort();
              keys = modelUtils.applyLimitAndOffset(opts, filteredKeys);
            } else if (opts.order === ['-name']) {
              filteredKeys.sort();
              filteredKeys.reverse();
              keys = modelUtils.applyLimitAndOffset(opts, filteredKeys);
            }

            debugfindSamples('Name filter only. sorted and applied' +
              ' limit/offset. Samples arr size: %d', keys.length);
          }

          return getSamplesAndAspects(keys);
        })
        .then((redisResponses) => {
          const { samples, sampAspectMap } = assembleSampleAspects(
            redisResponses);
          const fSamples = modelUtils.applyFiltersOnSampleObjs(samples,
            opts);
          return applyAttributesFilter(fSamples, opts,
            sampAspectMap, req.method);
        });
    } // featureToggle end

    /*
     * Send a batch of redis commands to get all the samples sorted
     * lexicographically by key (i.e. sample name). If there are no filters,
     * pass the limit and offset through as part of the initial redis command.
     * If there are filters, we need to load more records so we can return the
     * right number of records in case some get filtered out later.
     */
    const sortArgs = [constants.indexKey.sample, 'alpha'];
    const hasFilters = Object.keys(opts.filter).length > 0;
    if (!hasFilters) {
      sortArgs.push('LIMIT', opts.offset, opts.limit);
    }

    return Promise.resolve()
      .then(() => {
        // If there is a name param with no wildcards, get the sample directly.
        const nameFilter = opts.filter.name;
        if (nameFilter && !nameFilter.includes('*')) {
          const nameFilterArr = opts.filter.name.split(',').map((item) =>
            item.trim());
          if (nameFilterArr.length === 1) { // one sample
            return getOneSample(nameFilterArr[0])
              .then(([samp, asp]) => samp && asp ? [samp, asp] : []);
          }

          if (!hasOrder || opts.order === ['name']) {
            nameFilterArr.sort();
          }

          // multiple samples
          const sampleKeys = nameFilterArr.map((name) =>
            sampleStore.toKey(constants.objectType.sample, name));
          return getSamplesAndAspects(sampleKeys);
        }

        /*
         * Otherwise, get all sample keys, then prefilter based on sample name,
         * if specified. Then, for each of the
         * remaining sample keys, derive the aspect name and key from the sample
         * name, then add the commands to get the sample details and aspect
         * details from their respective objects in the sample store and execute
         * that batch of commands.
         */
        else {
          return redisClient.smembersAsync(
            sampleStore.constants.indexKey.sample)
            .then((sampleKeys) => {
              sampleKeys.sort();

              if (!hasFilters) {
                sampleKeys = modelUtils.applyLimitAndOffset(
                  opts, sampleKeys);
              }

              return sampleKeys;
            })
            .then((allSampKeys) => {
              const filteredSampKeys = hasFilters ?
                modelUtils.prefilterKeys(allSampKeys, opts) : allSampKeys;
              const commands = [];
              filteredSampKeys.forEach((sKey) => {
                const aNameSplit = sKey.split('|');
                var aName = aNameSplit[1];
                if(aNameSplit.length === 3) {
                  aName += '|' + aNameSplit[2];
                }
                
                const aKey = sampleStore.toKey(
                  constants.objectType.aspect, aName);
                commands.push(['hgetall', sKey]);
                commands.push(['hgetall', aKey]);
              });

              return redisClient.batch(commands).execAsync();
            });
        }
      })
      .then((redisResponses) => { // samples and aspects
        const samples = [];

        // e.g { samplename: asp object }, so that we can attach aspect later
        const sampAspectMap = {};
        for (let num = 0; num < redisResponses.length; num += TWO) {
          const sample = redisResponses[num];
          const aspect = redisResponses[num + ONE];
          if (sample && aspect) {
            samples.push(sample);
            sampAspectMap[redisResponses[num].name] = aspect;
          }
        }

        const filteredSamples = modelUtils.applyFiltersOnResourceObjs(samples,
          opts);
        return filteredSamples.map((sample) => {
          parseName(sample.name); // throw if invalid name
          if (opts.attributes) { // delete sample fields, hence no return obj
            modelUtils.applyFieldListFilter(sample, opts.attributes);
          }

          const s = cleanAddAspectToSample(sample, sampAspectMap[sample.name]);
          s.apiLinks = u.getApiLinks(s.name, helper, req.method);
          return s;
        });
      });
  }, // findSamples

  /**
   * Upsert sample in Redis.
   * @param  {Object} newSample - sample to upsert
   * @param {Object} user - The user performing the write operation
   * @returns {Promise} - Resolves to upserted sample
   */
  upsertSample(newSample, user) {
    try {
      parseName(newSample.name.toLowerCase());
    } catch (err) {
      return Promise.reject(err);
    }

    return getValuesForSamples([newSample])
    .then(([sampleAttributes]) => {
      prepareSampleForUpsert(newSample, sampleAttributes, user);
      return upsertOneSample(newSample, sampleAttributes, user)
      .then((result) =>
        prepareSampleForPublish(result, sampleAttributes)
      );
    });
  },

  /**
   * Upsert multiple samples in Redis concurrently.
   * @param  {Object} sampleQueryBody - Query body object
   * @param {Object} user - The user performing the write operation
   * @param {Array} readOnlyFields - An array of read-only-fields
   * @returns {Array} - Resolves to an array of resolved promises
   */
  bulkUpsertByName(sampleQueryBody, user, readOnlyFields) {
    // validate request body
    if (!sampleQueryBody || !Array.isArray(sampleQueryBody)) {
      return Promise.resolve([]);
    }

    // validate each sample, saving errors to be included inline in the response array
    const validSamples = [];
    const errors = [];
    let samplesAndAttributes;
    sampleQueryBody.forEach((sample, i) => {
      try {
        parseName(sample.name);
        commonUtils.noReadOnlyFieldsInReq(sample, readOnlyFields);
        validSamples[i] = sample;
      } catch (err) {
        errors[i] = { isFailed: true, explanation: err };
      }
    });
    logger.info("errors in the bulk upsert" + JSON.stringify(errors));

    const validSamplesOnly = validSamples.filter(Boolean);

    // get the relevant sample values from redis for all valid samples
    return getValuesForSamples(validSamplesOnly)
    .then((sampleAttributesArray) => {
      samplesAndAttributes = validSamples.map((newSample) => ({
        newSample,
        sampleAttributes: sampleAttributesArray.shift(),
      }));

      // prepare each sample, saving errors to be included inline in the response array
      validSamples.forEach((sample, i) => {
        const { newSample, sampleAttributes } = samplesAndAttributes[i];
        try {
          prepareSampleForUpsert(newSample, sampleAttributes, user);
        } catch (err) {
          delete samplesAndAttributes[i];
          errors[i] = { isFailed: true, explanation: err };
        }
      });

      const samplesAndAttributesOnly = samplesAndAttributes.filter(Boolean);
      return upsertSamples(samplesAndAttributesOnly, user);
    })

    // merge upsert results and errors into response array
    .then((results) => {
      const mergedResults = [];
      samplesAndAttributes.forEach(({ newSample, sampleAttributes }, i) => {
        const upsertedSample = results.shift();
        mergedResults[i] = prepareSampleForPublish(upsertedSample, sampleAttributes);
      });
      errors.forEach((err, i) => {
        mergedResults[i] = err;
      });
      return mergedResults;
    });
  }, // bulkUpsertByName

  cleanAddSubjectToSample, // export for testing only
  cleanAddAspectToSample, // export for testing only
  updateSampleAttributes, // export for testing only
  sscanAndFilterSampleKeys, // export for testing only
  checkWritePermission, // export for testing only
};
