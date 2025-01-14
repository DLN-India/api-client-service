const level = require("level");
const { Connection } = require("@nanolink/nanolink-tools/lib");
const { Subscriptions } = require("./definitions/mirrors");
const { GPSReceiver } = require("./receivers/gpsReceivers");
const {
  TransmitterLinksReceiver,
} = require("./receivers/transmitterLinksReceiver");
const {
  StatesReceiverDouble,
  DoubleFields,
} = require("./receivers/statesReceiver");
const { AppBase } = require("./appbase");
const { TripReceiver } = require("./receivers/tripReceiver");
const { WorkHoursReceiver } = require("./receivers/workHoursReceiver");

const VolageRanges = [
  { Low: 0.0, High: 13.0 },
  { Low: 16.0, High: 25.0 },
];

function Ignition(voltage) {
  let retVal = true;
  for (let n of VolageRanges) {
    if (voltage >= n.Low && voltage < n.High) {
      retVal = false;
      break;
    }
  }
  return retVal;
}

/**
 *  The main application class.
 */
class ExampleApp extends AppBase {
  db;
  references;
  trackers;
  vid2objectid;

  constructor(url, apitoken) {
    super(url, apitoken);
    this.db = level("./data");
  }
  /**
   * Make sure that a callback has the correct this
   * @param {function} f
   * @returns A function that is applied to "this"
   */
  callbackTo(f) {
    return (...p) => f.apply(this, p);
  }

  async onMirrorCreated(mirror) {
    /**
     *  Setup callbacks to keep track of changes. Version is persisted to allow for restarts
     */
    if (mirror.name == "references") {
      this.referenceVersion = await this.getCommittedVersion("references");
      mirror.onInserted = this.callbackTo(this.onReferenceAdded);
      mirror.onUpdated = this.callbackTo(this.onReferenceUpdated);
      mirror.onDeleted = this.callbackTo(this.onReferenceDeleted);
    } else if (mirror.name == "trackers") {
      this.trackerVersion = await this.getCommittedVersion("trackers");
      mirror.onInserted = this.callbackTo(this.onTrackerAdded);
      mirror.onUpdated = this.callbackTo(this.onTrackerUpdated);
      mirror.onDeleted = this.callbackTo(this.onTrackerDeleted);
    }
  }

  /**
   * Main application code. Change this function to your needs
   */
  async onReady() {
    console.log("Ready");
    /**
     * getMirror returns a Map with id as key and the document as value
     *
     * Note: the map is keep up-to date with changes from the server
     *
     * So if you i.e want the information for an asset just use:
     * \code
     *  let theReference = reference.get(referenceId)
     *  let name
     *  if (theReference.__typename == "QAsset") {
     *     name = theReference.brand + ' ' + theReference.model
     *  } else if (theReference.__typename == "QSite") {
     *     name = theReference.name
     *  } else if (theReference.__typename == "QUser") {
     *     name = theReference.fullName
     *  }
     * \endcode
     */
    this.references = await this.connection.getMirror("references");
    this.trackers = await this.connection.getMirror("trackers");
    /**
     * This code creates a Map between vID and ObjectId
     */
    this.vid2objectid = new Map();
    for (let tr of this.trackers.values()) {
      this.vid2objectid.set(tr.vID, tr.objId);
    }

    /**
     * This piece of code listens for GPS changes on trackers (receivers only)
     */
    let gpsReceivers = new GPSReceiver(this.connection);
    gpsReceivers.onDataReceived = this.callbackTo(this.onGPSDataUpdate);
    gpsReceivers.run();

    /**
     *  This piece of code listens for tracker link changes
     */

    let tlinkReceivers = new TransmitterLinksReceiver(
      this.connection,
      ["LAN_GATE_TRACKER"], // Only for Lan gates (set to null for all)
      true
    );
    tlinkReceivers.onDataReceived = this.callbackTo(
      this.onTransmitterLinkUpdate
    );
    /**
     * The are a couple of arguments to the run function
     * @see {TransmitterLinksReceiver.run}
     */
    tlinkReceivers.run(true, false, true, true);
    /**
     *  This piece of code listens for external voltage changes
     */
    let voltReceiver = new StatesReceiverDouble(
      this.connection,
      DoubleFields.EXTERNAL_VOLTAGE
    );
    voltReceiver.onDataReceived = this.callbackTo(this.onVoltageChanged);
    voltReceiver.run();

    /**
     * This receiver returns completed trips with GPS and Distance travelled (odoEnd - OdoStart)
     */
    let tripReceiver = new TripReceiver(this.connection);
    tripReceiver.onDataReceived = this.callbackTo(this.onTripReceived);
    tripReceiver.run(
      false, // Set to true if active links are need (i.e what tools are in the van during the trip)
      true, // Include GPS coordinates
      true, // Include odometer start/end
      ["180000C375FA"], // List of trackers, if null then all
      null, // start date/time
      null, // end date/time
      120, // Ignore stops shorter than this period
      false, // Set to true to get initial data from the server
      true // If true then events for new completed trips are sent
    );
    /**
     * This subscription returns periods where trackers has been running. (Ignition true)
     * Has the same arguments as the above subscription (tripReceiver)
     */
    let workHoursReceiver = new WorkHoursReceiver(this.connection);
    workHoursReceiver.onDataReceived = this.callbackTo(
      this.onWorkHoursReceived
    );
    workHoursReceiver.run(
      false,
      false,
      false,
      ["180000C375FA"],
      null,
      null,
      null,
      true,
      true
    );
  }

  async getCommittedVersion(mirror) {
    let retVal;
    try {
      retVal = await this.db.get(mirror);
    } catch {}
    return retVal ? parseInt(retVal) : -1;
  }
  async commitVersion(mirror, version) {
    this.db.put(mirror, version);
  }
  onReferenceAdded(mirror, reference) {
    // Make sure a change is only processed once
    if (this.referenceVersion < mirror.version) {
      /**
       *   Put in code here to syncronize with your system
       */
      console.log("Reference added: ", JSON.stringify(reference, null, 4));
      // -----------------------------------------------
      this.referenceVersion = mirror.version;
      this.commitVersion("references", this.referenceVersion);
    }
  }
  onReferenceUpdated(mirror, reference, _orgReference) {
    // Make sure a change is only processed once
    if (this.referenceVersion < mirror.version) {
      /**
       *   Put in code here to syncronize with your system
       */
      console.log("Reference updated: ", JSON.stringify(reference, null, 4));
      /**
       *
       */
      this.referenceVersion = mirror.version;
      this.commitVersion("references", this.referenceVersion);
    }
  }
  onReferenceDeleted(mirror, reference) {
    // Make sure a change is only processed once
    if (this.referenceVersion < mirror.version) {
      /**
       *   Put in code here to syncronize with your system
       */
      console.log("Reference deleted: ", JSON.stringify(reference, null, 4));
      /**
       *
       */
      this.referenceVersion = mirror.version;
      this.commitVersion("references", this.referenceVersion);
    }
  }

  onTrackerAdded(mirror, tracker) {
    // Make sure a change is only processed once
    if (this.trackerVersion < mirror.version) {
      /**
       *   Put in code here to syncronize with your system
       */
      console.log("Tracker added: ", JSON.stringify(tracker, null, 4));
      /**
       *
       */
      this.trackerVersion = mirror.version;
      this.commitVersion("trackers", this.trackerVersion);
    }
  }
  onTrackerUpdated(mirror, tracker, _orgTracker) {
    if (this.trackerVersion < mirror.version) {
      /**
       *   Put in code here to syncronize with your system
       */
      console.log("Tracker updated: ", JSON.stringify(tracker, null, 4));
      /**
       *
       */
      this.trackerVersion = mirror.version;
      this.commitVersion("trackers", this.trackerVersion);
    }
  }
  onTrackerDeleted(mirror, tracker) {
    if (this.trackerVersion < mirror.version) {
      /**
       *   Put in code here to syncronize with your system
       */
      console.log("Tracker deleted: ", JSON.stringify(tracker, null, 4));
      /**
       *
       */
      this.trackerVersion = mirror.version;
      this.commitVersion("trackers", this.trackerVersion);
    }
  }
  onGPSDataUpdate(gps) {
    /**
     * If you need all information on the tracker, just look it up in trackers
     */

    // Depending on the unwind parameter this could be a single item or an array
    if (Array.isArray(gps)) {
      for (var g of gps) {
        g.tracker = this.trackers.get(g.trackerVID);
      }
    } else {
      gps.tracker = this.trackers.get(gps.trackerVID);
    }
    /**
     * If you need to know which reference the tracker is attached to, just do this
     */
    if (Array.isArray(gps)) {
      for (var g of gps) {
        g.reference = this.references.get(g.tracker.referenceId);
      }
    } else {
      gps.reference = this.references.get(gps.tracker.referenceId);
    }
    console.log(gps);
  }

  /**
   * This callback is called
   * @param {OTransmitterLink} tlink
   */
  onTransmitterLinkUpdate(tlink) {
    let link = tlink.nearest ?? tlink.newest;
    let antenna;
    if (link) {
      antenna = {
        vID: link.vID,
        objId: this.vid2objectid.get(link.vID),
        rSSI: link.rSSI,
        linkActive: tlink.nearest != null,
        lastUpdated: link?.lastUpdated,
        latitude: link?.position?.locationInfo?.latitude,
        longitude: link?.position?.locationInfo?.longitude,
      };
    }
    let beaconPosition = {
      vID: tlink.vID,
      objId: this.vid2objectid.get(link.vID),
      antenna: antenna,
    };
    console.log(beaconPosition);
  }

  trackerIgnitionState = new Map();
  onVoltageChanged(data) {
    /**
     * This callback receives external voltage changes
     */
    let pState = this.trackerIgnitionState.get(data.vID);
    let nState = Ignition(data.value);
    if (pState != undefined) {
      if (pState != nState) {
        this.trackerIgnitionState.set(data.vID, nState);
        this.onIgnitionChanged(data, nState);
      }
    } else {
      this.trackerIgnitionState.set(data.vID, nState);
      this.onIgnitionChanged(data, nState);
    }
  }

  onIgnitionChanged(data, ignition) {
    /**
     *  This callback tells if the cars engine has ignition
     */
    console.log(`${data.vID} ignition is ${ignition ? "on" : "off"}`);
  }

  onTripReceived(data) {
    console.log("TRIP:", data);
  }
  onWorkHoursReceived(data) {
    console.log("WORKHOURS (in s)", data);
  }

  /**
   * Example on how to map ObjectId to vID and vice versa.
   */

  MigrateObjectId2VID() {
    for (let tracker of this.trackers.values()) {
      let vid = tracker.vID;
      let objId = traacker.objId;
      // Do migration code here
    }
  }
}
module.exports = { ExampleApp };
